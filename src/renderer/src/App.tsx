import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  DockerLogIpc,
  DockerStateIpc,
  FrameAtLoopIpc,
  GameCatalogIpc,
  GameSummaryIpc,
  RecordingInfo,
  SessionStatusIpc,
  StartSessionOptionsIpc,
  TelemetryWatchIpc,
  TerrainDataIpc,
  UnitSummaryIpc,
  UnitTypeInfoIpc,
} from "../../shared/ipc-types";
import type { ChannelIpc, EventIpc, TelemetryStateIpc, TelemetryStreamIpc } from "../../shared/telemetry-types";
import { ChannelTree } from "./components/ChannelTree";
import { EventLog } from "./components/EventLog";
import { GameCatalog } from "./components/GameCatalog";
import { MapView, type MapViewHandle } from "./components/MapView";
import { Minimap } from "./components/Minimap";
import { SeriesChart } from "./components/SeriesChart";
import { SessionPanel } from "./components/SessionPanel";
import { SnapshotInspector } from "./components/SnapshotInspector";
import { Timeline } from "./components/Timeline";
import { UnitInspector } from "./components/UnitInspector";

/** SC2's normal-speed loop rate: 22.4 game loops per real second. Widely
 * documented across the SC2 AI/ladder tooling community for loop<->time
 * conversion; "1x" playback here means real game speed. */
const LOOPS_PER_SECOND = 22.4;

/** Docker's build output can run to thousands of lines; the panel keeps the
 * tail, which is the part that says what went wrong. */
const MAX_LOG_LINES = 500;

/**
 * The three things the window can be showing. `catalog` is the history
 * browser (§6.4) and is where the app opens: a list of games is a more useful
 * empty state than a button that opens a file picker.
 */
type ViewKind = "catalog" | "recording" | "live";

/** The two of those that are a game, which is what main answers queries
 * from. The catalog reads files directly and needs no active source. */
type SourceKind = "recording" | "live";

/**
 * Whether an imported telemetry file looks like it belongs to some other
 * game, which §3.5 says has to be recoverable and is better not to do in the
 * first place.
 *
 * The test is how much of the file lands inside the game at all. Telemetry
 * legitimately runs a little past the last recorded frame, so an overrun is
 * not itself suspicious; a file whose loops are mostly outside the game is
 * another run's, and the half is a stated threshold rather than a guess at
 * intent. Returns null when there is nothing to warn about.
 */
function rangeMismatch(firstLoop: number | null, lastLoop: number | null, gameMaxLoop: number): string | null {
  if (firstLoop === null || lastLoop === null || gameMaxLoop <= 0) return null;
  const span = lastLoop - firstLoop;
  if (span <= 0) return null;
  const overlap = Math.min(lastLoop, gameMaxLoop) - Math.max(firstLoop, 0);
  if (overlap / span >= 0.5) return null;
  return (
    `Careful: that file covers loops ${firstLoop} to ${lastLoop}, and this game only reaches ${gameMaxLoop}. ` +
    "It may belong to another game; you can detach it under Channels."
  );
}

/** A session owns the client between these phases, which is when it is the
 * thing the viewer should be showing. */
function sessionRunning(status: SessionStatusIpc | null): boolean {
  if (!status) return false;
  return status.phase !== "idle" && status.phase !== "stopped" && status.phase !== "failed";
}

export function App(): JSX.Element {
  const [recording, setRecording] = useState<RecordingInfo | null>(null);
  /**
   * A running session and an opened recording can both exist; this is the one
   * on screen. Main is told, so its queries answer from the same store (§6.4
   * keeps frames off the store, but telemetry genuinely lives in it).
   */
  const [view, setView] = useState<ViewKind>("catalog");
  /** The games folder as main last peeked it. Null until the catalog is
   * first asked for. */
  const [catalog, setCatalog] = useState<GameCatalogIpc | null>(null);
  const [catalogProblem, setCatalogProblem] = useState<string | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  /** Which game view the catalog came from, so leaving it goes back to what
   * was on screen rather than always to the recording. */
  const [lastSource, setLastSource] = useState<SourceKind>("recording");
  const [session, setSession] = useState<SessionStatusIpc | null>(null);
  const [dockerState, setDockerState] = useState<DockerStateIpc | null>(null);
  const [maps, setMaps] = useState<string[]>([]);
  const [logs, setLogs] = useState<DockerLogIpc[]>([]);
  /** Ticks while live, so the idle counters advance on their own (§4.2). */
  const [clock, setClock] = useState(Date.now());
  const [terrain, setTerrain] = useState<TerrainDataIpc | null>(null);
  const [unitTypeInfo, setUnitTypeInfo] = useState<Record<number, UnitTypeInfoIpc>>({});
  const [loop, setLoop] = useState(0);
  const [frame, setFrame] = useState<FrameAtLoopIpc | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<UnitSummaryIpc | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [channels, setChannels] = useState<ChannelIpc[]>([]);
  const [streams, setStreams] = useState<TelemetryStreamIpc[]>([]);
  const [visibleChannels, setVisibleChannels] = useState<ReadonlySet<string>>(new Set());
  const [telemetry, setTelemetry] = useState<TelemetryStateIpc | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dockTab, setDockTab] = useState<"series" | "events" | "snapshots">("series");
  const [dockHeight, setDockHeight] = useState(200);
  const [selectedSeries, setSelectedSeries] = useState<ReadonlySet<string>>(new Set());
  /** Bumped when telemetry is ingested, so panels that hold whole-game query
   * results (the event log, the timeline ticks) know to refetch. */
  const [telemetryRevision, setTelemetryRevision] = useState(0);
  const [timelineEvents, setTimelineEvents] = useState<EventIpc[]>([]);
  const [watch, setWatch] = useState<TelemetryWatchIpc | null>(null);

  const mapHandleRef = useRef<MapViewHandle | null>(null);
  const loopRef = useRef(0);
  const lastFetchedLoopRef = useRef(-1);
  /** Channels already offered to the user. A tailed file can introduce a
   * channel at any loop, and it should arrive at its declared default without
   * resetting boxes the user has ticked since. */
  const seenChannelsRef = useRef<Set<string>>(new Set());
  /** Read inside push handlers, which must not disturb a recording the user
   * switched to while a session keeps running behind it. */
  const viewRef = useRef(view);
  const lastFrameAtRef = useRef(0);
  const lastTelemetryAtRef = useRef<number | null>(null);

  const live = view === "live" && sessionRunning(session);
  const map = live ? session!.map : recording?.map ?? "";
  const mode = live ? session!.mode : recording?.mode ?? "";
  // Live has nothing past the head to scrub to (§6.4), so the track's end is
  // wherever the game is now and the thumb sits on it.
  const maxLoop = live ? loop : recording?.maxLoop ?? 0;

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /**
   * Channels default to whatever the bot's `hello` declared, falling back to
   * visible, so attaching a file shows something rather than an empty map.
   * `reset` re-applies those defaults wholesale, which is what opening or
   * attaching wants; a live append merges instead.
   */
  const loadChannels = useCallback(async (reset: boolean) => {
    const [channelList, streamList, events] = await Promise.all([
      window.spectator.getChannels(),
      window.spectator.getTelemetryStreams(),
      window.spectator.getEvents({}),
    ]);
    setChannels(channelList);
    setStreams(streamList);
    setTimelineEvents(events);

    if (reset) seenChannelsRef.current = new Set();
    const fresh = channelList.filter((channel) => !seenChannelsRef.current.has(channel.ch));
    for (const channel of fresh) seenChannelsRef.current.add(channel.ch);
    setVisibleChannels((current) => {
      const next = reset ? new Set<string>() : new Set(current);
      for (const channel of fresh) {
        if (channel.defaultVisible) next.add(channel.ch);
      }
      return next;
    });
    setTelemetryRevision((revision) => revision + 1);
  }, []);

  /** Everything the viewer resets when the game under it changes. Shared by
   * the picker and, from Phase 5's catalog, by a clicked row. */
  const showRecording = useCallback(async (info: RecordingInfo) => {
    setRecording(info);
    // Main has already pointed its queries at this file; the view follows,
    // and so does what the catalog offers to go back to.
    setView("recording");
    setLastSource("recording");
    setSelectedUnit(null);
    setPlaying(false);
    loopRef.current = 0;
    setLoop(0);
    lastFetchedLoopRef.current = -1;
    setTelemetry(null);
    setNotice(null);
    setSelectedSeries(new Set());
    setTimelineEvents([]);
    // Main stops the tailer when the store it writes into is replaced.
    setWatch(null);

    const [terrainData, typeInfo] = await Promise.all([window.spectator.getTerrain(), window.spectator.getUnitTypeInfo()]);
    setTerrain(terrainData);
    setUnitTypeInfo(typeInfo);
    await loadChannels(true);
  }, [loadChannels]);

  const openRecording = useCallback(async () => {
    const result = await window.spectator.pickAndOpenRecording();
    if (result.status === "cancelled") return;
    if (result.status !== "done" || !result.recording) {
      setNotice(result.problem ?? "That game could not be opened.");
      return;
    }
    await showRecording(result.recording);
  }, [showRecording]);

  const attachTelemetry = useCallback(async () => {
    const result = await window.spectator.attachTelemetry();
    if (!result) return;

    if (result.status === "already-attached") {
      setNotice("Already attached to this recording.");
      return;
    }
    const ingested = result.ingested;
    if (ingested && ingested.rejectedCount > 0) {
      // Rejections are never fatal (§4), but silently dropping lines would
      // leave a bot author debugging a gap the app already knows about.
      setNotice(`${ingested.messageCount} messages, ${ingested.rejectedCount} line(s) rejected (see console).`);
      console.warn(
        `[telemetry] ${ingested.rejectedCount} line(s) rejected:`,
        ingested.rejections.map((r) => `line ${r.line}: ${r.reason}`)
      );
    } else if (ingested) {
      setNotice(`${ingested.messageCount} messages, loops ${ingested.firstLoop} to ${ingested.lastLoop}.`);
    }

    if (ingested) {
      const mismatch = rangeMismatch(ingested.firstLoop, ingested.lastLoop, recording?.maxLoop ?? 0);
      if (mismatch) setNotice(mismatch);
      // Telemetry can run past the last recorded frame, and the timeline has
      // to grow with it or the messages sit where no scrubbing reaches them.
      if (ingested.lastLoop !== null) {
        setRecording((current) =>
          current ? { ...current, maxLoop: Math.max(current.maxLoop, ingested.lastLoop!) } : current
        );
      }
    }

    await loadChannels(true);
    // The loop has not changed, so the fetch effect will not re-run; pull the
    // newly-ingested state for where the cursor already is.
    setTelemetry(await window.spectator.getTelemetryAtLoop(loop));
  }, [loadChannels, loop, recording]);

  /**
   * §3.5's recovery, from the stream list in the channel panel. Main removes
   * the rows and rebuilds the checkpoints; here the game gets shorter, the
   * channels it contributed disappear, and the loop on screen is re-resolved
   * without it.
   */
  const detachStream = useCallback(
    async (streamId: number) => {
      const result = await window.spectator.detachStream(streamId);
      setStreams(result.streams);
      if (result.status !== "done") {
        setNotice(result.problem ?? "That stream could not be detached.");
        return;
      }
      setNotice(null);
      setRecording((current) => (current ? { ...current, maxLoop: result.maxLoop } : current));
      if (loopRef.current > result.maxLoop) {
        loopRef.current = result.maxLoop;
        setLoop(result.maxLoop);
      }
      await loadChannels(true);
      setTelemetry(await window.spectator.getTelemetryAtLoop(loopRef.current));
    },
    [loadChannels]
  );

  const toggleWatch = useCallback(async () => {
    if (watch) {
      await window.spectator.stopWatchingTelemetry();
      setWatch(null);
      return;
    }
    const started = await window.spectator.watchTelemetryFolder();
    if (!started) return;
    setWatch(started);
    // Files already sitting in the folder are ingested by the first poll,
    // which has happened by the time this returns.
    await loadChannels(false);
    if (lastFetchedLoopRef.current >= 0) {
      setTelemetry(await window.spectator.getTelemetryAtLoop(lastFetchedLoopRef.current));
    }
  }, [watch, loadChannels]);

  // -- the live session ----------------------------------------------------

  const refreshDocker = useCallback(() => {
    void window.spectator.getDockerState().then(setDockerState);
  }, []);

  /** Set below, once switchView exists. The mount effect needs it without
   * taking it as a dependency, which would re-run the adoption. */
  const switchViewRef = useRef<(kind: SourceKind) => Promise<void>>(async () => undefined);

  /**
   * A reloaded window (or a hot reload during development) comes up knowing
   * nothing, while the session in main is still playing. Adopting it is what
   * makes the live view survive a reload instead of dropping to the splash
   * with a game running behind it.
   */
  useEffect(() => {
    void window.spectator.listMaps().then(setMaps);
    void window.spectator.getSessionState().then((state) => {
      setSession(state);
      if (sessionRunning(state)) void switchViewRef.current("live");
    });
    refreshDocker();
  }, [refreshDocker]);

  /**
   * The live feed. Frames and terrain arrive as pushes rather than queries,
   * because §6.4 keeps the live viewer off the store; the guard is there
   * because a session keeps running while the user looks at a recording, and
   * its frames must not redraw that recording's map.
   */
  useEffect(() => {
    const offState = window.spectator.onSessionState(setSession);
    const offLog = window.spectator.onDockerLog((line) => {
      setLogs((current) => [...current.slice(-(MAX_LOG_LINES - 1)), line]);
    });
    const offTerrain = window.spectator.onLiveTerrain((payload) => {
      if (viewRef.current !== "live") return;
      setTerrain(payload.terrain);
      setUnitTypeInfo(payload.unitTypes);
      // A map arriving is a game starting, and none of the last game's
      // selection or overlays belong to it. The frame is deliberately left
      // alone: the next one replaces it within a frame time, and clearing it
      // here is what blanks the map for as long as the next bot takes to
      // connect, which can be minutes.
      if (payload.terrain) {
        setSelectedUnit(null);
        setTelemetry(null);
        lastFetchedLoopRef.current = -1;
      }
    });
    const offFrame = window.spectator.onLiveFrame((liveFrame) => {
      lastFrameAtRef.current = Date.now();
      if (viewRef.current !== "live") return;
      setFrame(liveFrame);
      loopRef.current = liveFrame.loop;
      setLoop(liveFrame.loop);
    });
    return () => {
      offState();
      offLog();
      offTerrain();
      offFrame();
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [live]);

  const startSession = useCallback(async (options: StartSessionOptionsIpc) => {
    setLogs([]);
    setView("live");
    viewRef.current = "live";
    setTerrain(null);
    setUnitTypeInfo({});
    setFrame(null);
    setSelectedUnit(null);
    setTelemetry(null);
    setNotice(null);
    setWatch(null);
    setChannels([]);
    setTimelineEvents([]);
    setVisibleChannels(new Set());
    seenChannelsRef.current = new Set();
    loopRef.current = 0;
    setLoop(0);
    lastFetchedLoopRef.current = -1;
    lastFrameAtRef.current = 0;
    lastTelemetryAtRef.current = null;
    // Resolves only once the container is up and the first game is created,
    // which on a cold cache means a build; the pushes keep the UI current in
    // the meantime.
    setSession(await window.spectator.startSession(options));
    refreshDocker();
  }, [refreshDocker]);

  const stopSession = useCallback(async () => {
    setSession(await window.spectator.stopSession());
    refreshDocker();
  }, [refreshDocker]);

  // -- the history browser -------------------------------------------------

  /**
   * The list is peeked off the folder on every call rather than cached, so
   * asking again is how it stays true: a game deleted in Explorer, or one the
   * running session just finished, shows up on the next refresh.
   */
  const refreshCatalog = useCallback(async () => {
    setCatalog(await window.spectator.listGames());
  }, []);

  /**
   * The list is a snapshot of a folder other things write into, so it is
   * re-peeked whenever it comes on screen and whenever the session closes a
   * game, which is when a new row exists to show.
   */
  useEffect(() => {
    if (view !== "catalog") return;
    void refreshCatalog();
  }, [view, session?.gameFile, session?.gamesPlayed, refreshCatalog]);

  const showCatalog = useCallback(() => {
    setView("catalog");
    viewRef.current = "catalog";
    setCatalogProblem(null);
    setCatalogNotice(null);
    void refreshCatalog();
  }, [refreshCatalog]);

  /** The viewer after the game under it has gone. Main has already closed the
   * store; this is the window catching up. */
  const clearRecordingView = useCallback(() => {
    setRecording(null);
    setTerrain(null);
    setUnitTypeInfo({});
    setFrame(null);
    setSelectedUnit(null);
    setTelemetry(null);
    setChannels([]);
    setStreams([]);
    setVisibleChannels(new Set());
    seenChannelsRef.current = new Set();
    setTimelineEvents([]);
    setWatch(null);
    setPlaying(false);
    loopRef.current = 0;
    setLoop(0);
    lastFetchedLoopRef.current = -1;
  }, []);

  /** Tags are written to the game file itself, so the answer comes back as a
   * fresh listing rather than as an optimistic edit of the row. */
  const setGameTags = useCallback(async (game: GameSummaryIpc, tags: string[]) => {
    const result = await window.spectator.setGameTags(game.filePath, tags);
    setCatalog(result.catalog);
    setCatalogProblem(result.problem);
    if (result.status === "done") setCatalogNotice(null);
  }, []);

  const exportGame = useCallback(async (game: GameSummaryIpc) => {
    const result = await window.spectator.exportGame(game.filePath);
    setCatalog(result.catalog);
    setCatalogProblem(result.problem);
    if (result.status === "done") setCatalogNotice(`Exported ${game.fileName}.`);
  }, []);

  /**
   * Delete. Main refuses the game being played and closes the open recording
   * before unlinking it, because Windows will not remove a file SQLite still
   * holds; if that was the game on screen, the window has to let go of it too.
   */
  const deleteGame = useCallback(
    async (game: GameSummaryIpc) => {
      const wasOpen = recording?.filePath === game.filePath;
      const result = await window.spectator.deleteGame(game.filePath);
      setCatalog(result.catalog);
      setCatalogProblem(result.problem);
      if (result.status !== "done") return;
      setCatalogNotice(`${game.fileName} is in the recycle bin.`);
      if (wasOpen) clearRecordingView();
    },
    [recording, clearRecordingView]
  );

  /**
   * Clicking a row. The game being played right now is not opened as a file:
   * its store belongs to the session, and the live view is already showing
   * it, so the click goes there instead.
   */
  const openGameRow = useCallback(
    async (game: GameSummaryIpc) => {
      if (catalog?.liveFilePath === game.filePath) {
        await switchViewRef.current("live");
        return;
      }
      const result = await window.spectator.openGame(game.filePath);
      if (result.status !== "done" || !result.recording) {
        setCatalogProblem(result.problem ?? "That game could not be opened.");
        void refreshCatalog();
        return;
      }
      setCatalogProblem(null);
      setLastSource("recording");
      await showRecording(result.recording);
    },
    [catalog, refreshCatalog, showRecording]
  );

  /** Switching what the window shows also switches what main answers from. */
  const switchView = useCallback(
    async (kind: SourceKind) => {
      setView(kind);
      viewRef.current = kind;
      setLastSource(kind);
      lastFetchedLoopRef.current = -1;
      await window.spectator.setActiveSource(kind);
      if (kind === "recording") {
        const [terrainData, typeInfo] = await Promise.all([
          window.spectator.getTerrain(),
          window.spectator.getUnitTypeInfo(),
        ]);
        setTerrain(terrainData);
        setUnitTypeInfo(typeInfo);
      }
      // Live terrain and the current frame are re-pushed by main.
      await loadChannels(true);
    },
    [loadChannels]
  );
  switchViewRef.current = switchView;

  /**
   * Main's push says only "there is more", so the answer is to re-ask for the
   * loop already on screen. The tailer can announce every poll (~150ms) while
   * a bot is writing, and a channel rebuild plus a whole-game event query at
   * that rate is more than the view needs, so announcements are coalesced.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.spectator.onTelemetryAppended(() => {
      lastTelemetryAtRef.current = Date.now();
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void loadChannels(false);
        void window.spectator.getTelemetryWatch().then(setWatch);
        if (lastFetchedLoopRef.current >= 0) {
          void window.spectator.getTelemetryAtLoop(lastFetchedLoopRef.current).then(setTelemetry);
        }
      }, 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [loadChannels]);

  // Fetch the frame and the telemetry state for the current loop whenever it
  // changes (seek, or a playback tick that crossed to a new integer loop).
  // Both in one round so the map never shows a unit frame and an overlay from
  // different loops.
  // In live mode the frame is pushed, so only the telemetry for that loop is
  // fetched; asking the store for a frame it may not have flushed yet is what
  // §6.4 forbids.
  useEffect(() => {
    if (!recording && !live) return;
    if (loop === lastFetchedLoopRef.current) return;
    lastFetchedLoopRef.current = loop;
    let cancelled = false;
    const framePromise = live ? Promise.resolve(null) : window.spectator.getFrameAtLoop(loop);
    Promise.all([framePromise, window.spectator.getTelemetryAtLoop(loop)]).then(([frameResult, telemetryResult]) => {
      if (cancelled) return;
      if (!live) setFrame(frameResult);
      setTelemetry(telemetryResult);
    });
    return () => {
      cancelled = true;
    };
  }, [recording, live, loop]);

  // Playback loop. Live has no playback: it follows the head.
  useEffect(() => {
    if (!playing || !recording || live) return;
    let raf = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const deltaSeconds = (now - lastTime) / 1000;
      lastTime = now;
      const next = loopRef.current + deltaSeconds * LOOPS_PER_SECOND * speed;
      if (next >= recording.maxLoop) {
        loopRef.current = recording.maxLoop;
        setLoop(recording.maxLoop);
        setPlaying(false);
        return;
      }
      loopRef.current = next;
      setLoop(Math.floor(next));
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, recording, live]);

  const handleSeek = useCallback((value: number) => {
    loopRef.current = value;
    setLoop(value);
  }, []);

  const handleRecenter = useCallback((worldX: number, worldY: number) => {
    mapHandleRef.current?.recenterOn(worldX, worldY);
  }, []);

  const handleToggleSeries = useCallback((key: string, on: boolean) => {
    setSelectedSeries((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  /** Drag the dock's top edge. Listeners go on window so the pointer can
   * leave the 6px handle mid-drag without the resize sticking. */
  const startDockResize = useCallback((event: React.PointerEvent) => {
    const startY = event.clientY;
    const startHeight = dockHeight;
    const onMove = (move: PointerEvent): void => {
      setDockHeight(Math.max(0, Math.min(560, startHeight - (move.clientY - startY))));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [dockHeight]);

  const handleToggleChannels = useCallback((paths: string[], show: boolean) => {
    setVisibleChannels((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (show) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  }, []);

  const sessionPanel = (compact: boolean): JSX.Element => (
    <SessionPanel
      status={session}
      docker={dockerState}
      maps={maps}
      logs={logs}
      onStart={(options) => void startSession(options)}
      onStop={() => void stopSession()}
      compact={compact}
    />
  );

  // Where a game can be gone back to from the catalog: the live game if that
  // is what was on screen, otherwise whatever is open.
  const returnTo: SourceKind | null =
    lastSource === "live" && sessionRunning(session) ? "live" : recording ? "recording" : sessionRunning(session) ? "live" : null;

  if (view === "catalog" || (!recording && !live)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid #2b323d",
            fontSize: 13,
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <span>Games</span>
          {returnTo && (
            <button onClick={() => void switchView(returnTo)} style={{ fontSize: 12 }}>
              Back to {returnTo === "live" ? "the live game" : "the recording"}
            </button>
          )}
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {/* Games from elsewhere: a copy someone sent, or the repo's
                fixtures. Anything in the games folder is already a row. */}
            <button onClick={openRecording}>Open Recording...</button>
            {sessionPanel(true)}
          </span>
        </div>
        <GameCatalog
          catalog={catalog}
          problem={catalogProblem}
          notice={catalogNotice}
          onOpen={(game) => void openGameRow(game)}
          onRefresh={() => void refreshCatalog()}
          onSetTags={(game, tags) => void setGameTags(game, tags)}
          onExport={(game) => void exportGame(game)}
          onDelete={(game) => void deleteGame(game)}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid #2b323d",
          fontSize: 13,
          display: "flex",
          gap: 16,
          alignItems: "center",
        }}
      >
        <button onClick={showCatalog} style={{ fontSize: 12 }} title="Back to the list of games">
          Games
        </button>
        <span>{map}</span>
        <span style={{ color: "#8b93a1" }}>mode {mode}</span>
        {recording && sessionRunning(session) && (
          <span style={{ display: "flex", gap: 4 }}>
            {(["live", "recording"] as const).map((kind) => (
              <button
                key={kind}
                onClick={() => void switchView(kind)}
                style={{
                  fontSize: 12,
                  background: view === kind ? "#242a33" : "transparent",
                  color: view === kind ? "#e7e9ec" : "#8b93a1",
                  border: "1px solid #2b323d",
                  borderRadius: 4,
                  padding: "2px 8px",
                  cursor: "pointer",
                }}
              >
                {kind}
              </button>
            ))}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {watch && (
            <span
              title={watch.dir}
              style={{ color: "#8b93a1", fontSize: 12, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              watching {watch.files.length} file{watch.files.length === 1 ? "" : "s"} in {watch.dir}
              {watch.skippedCount > 0 && `, ${watch.skippedCount} skipped`}
            </span>
          )}
          {/* Not offered during a session: the session already watches the
              telemetry folder for the game being played, and pointing this at
              a folder mid-game imports every earlier run sitting in it, each
              on its own loop axis, into the live recording. */}
          {!live && <button onClick={toggleWatch}>{watch ? "Stop Watching" : "Watch Folder..."}</button>}
          <button onClick={openRecording}>Open Recording...</button>
          {sessionPanel(true)}
        </span>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          style={{
            width: 200,
            borderRight: "1px solid #2b323d",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <ChannelTree
            channels={channels}
            visible={visibleChannels}
            onToggle={handleToggleChannels}
            onAttach={live ? null : attachTelemetry}
            streams={streams}
            // Detaching underneath a tailer would have it re-create the
            // stream on its next poll, so it is not offered while one is
            // reading into this game; main refuses it as well.
            onDetach={live || watch ? null : (id) => void detachStream(id)}
            notice={notice}
          />
        </div>

        <div style={{ flex: 1, position: "relative" }}>
          <MapView
            terrain={terrain}
            frame={frame}
            selectedTag={selectedUnit?.tag ?? null}
            onSelectUnit={setSelectedUnit}
            unitTypeInfo={unitTypeInfo}
            mapHandleRef={mapHandleRef}
            telemetry={telemetry}
            visibleChannels={visibleChannels}
          />
        </div>

        <div
          style={{
            width: 240,
            borderLeft: "1px solid #2b323d",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            // Flex items default to min-height:auto, so without this the rail
            // refuses to shrink below its content and grows past the bottom of
            // the window as the dock is dragged taller.
            minHeight: 0,
          }}
        >
          <Minimap terrain={terrain} frame={frame} onRecenter={handleRecenter} />
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <UnitInspector unit={selectedUnit} unitTypeInfo={unitTypeInfo} entities={telemetry?.entities ?? []} />
          </div>
        </div>
      </div>

      <div
        onPointerDown={startDockResize}
        style={{ height: 6, cursor: "ns-resize", borderTop: "1px solid #2b323d", background: "#171b21", flexShrink: 0 }}
      />
      <div style={{ height: dockHeight, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 4, padding: "6px 16px 0" }}>
          {(["series", "events", "snapshots"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setDockTab(tab)}
              style={{
                fontSize: 12,
                textTransform: "capitalize",
                background: dockTab === tab ? "#242a33" : "transparent",
                color: dockTab === tab ? "#e7e9ec" : "#8b93a1",
                border: "1px solid #2b323d",
                borderRadius: 4,
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: "8px 16px 10px" }}>
          {dockTab === "series" ? (
            <SeriesChart
              channels={channels}
              selected={selectedSeries}
              onToggle={handleToggleSeries}
              loop={loop}
              maxLoop={maxLoop}
              onSeek={handleSeek}
            />
          ) : dockTab === "events" ? (
            <EventLog
              channels={channels.filter((c) => c.kind === "event").map((c) => c.ch)}
              loop={loop}
              onSeek={handleSeek}
              revision={telemetryRevision}
            />
          ) : (
            <SnapshotInspector snapshots={(telemetry?.snapshots ?? []).filter((s) => visibleChannels.has(s.ch))} />
          )}
        </div>
      </div>

      <div style={{ borderTop: "1px solid #2b323d" }}>
        <Timeline
          loop={loop}
          maxLoop={maxLoop}
          playing={playing}
          speed={speed}
          onSeek={handleSeek}
          onTogglePlay={() => setPlaying((p) => !p)}
          onSpeedChange={setSpeed}
          events={timelineEvents}
          live={
            live
              ? {
                  frameIdleMs: lastFrameAtRef.current === 0 ? 0 : clock - lastFrameAtRef.current,
                  telemetryIdleMs: lastTelemetryAtRef.current === null ? null : clock - lastTelemetryAtRef.current,
                }
              : null
          }
        />
      </div>
    </div>
  );
}
