import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  DockerLogIpc,
  DockerStateIpc,
  FrameAtLoopIpc,
  RecordingInfo,
  SessionStatusIpc,
  StartSessionOptionsIpc,
  TelemetryWatchIpc,
  TerrainDataIpc,
  UnitSummaryIpc,
  UnitTypeInfoIpc,
} from "../../shared/ipc-types";
import type { ChannelIpc, EventIpc, TelemetryStateIpc } from "../../shared/telemetry-types";
import { ChannelTree } from "./components/ChannelTree";
import { EventLog } from "./components/EventLog";
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
  const [view, setView] = useState<"recording" | "live">("recording");
  const [session, setSession] = useState<SessionStatusIpc | null>(null);
  const [dockerState, setDockerState] = useState<DockerStateIpc | null>(null);
  const [maps, setMaps] = useState<string[]>([]);
  const [logs, setLogs] = useState<DockerLogIpc[]>([]);
  const [liveMaxLoop, setLiveMaxLoop] = useState(0);
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
  const [streamCount, setStreamCount] = useState(0);
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
  const maxLoop = live ? liveMaxLoop : recording?.maxLoop ?? 0;

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
    const [channelList, streams, events] = await Promise.all([
      window.spectator.getChannels(),
      window.spectator.getTelemetryStreams(),
      window.spectator.getEvents({}),
    ]);
    setChannels(channelList);
    setStreamCount(streams.length);
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

  const openRecording = useCallback(async () => {
    const info = await window.spectator.pickAndOpenRecording();
    if (!info) return;
    setRecording(info);
    // Main has already pointed its queries at this file; the view follows.
    setView("recording");
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

    await loadChannels(true);
    // The loop has not changed, so the fetch effect will not re-run; pull the
    // newly-ingested state for where the cursor already is.
    setTelemetry(await window.spectator.getTelemetryAtLoop(loop));
  }, [loadChannels, loop]);

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

  useEffect(() => {
    void window.spectator.listMaps().then(setMaps);
    void window.spectator.getSessionState().then(setSession);
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
    });
    const offFrame = window.spectator.onLiveFrame((liveFrame) => {
      lastFrameAtRef.current = Date.now();
      if (viewRef.current !== "live") return;
      setFrame(liveFrame);
      setLiveMaxLoop((current) => Math.max(current, liveFrame.loop));
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

  // A new game is a new map and a new loop axis, so nothing from the last one
  // may survive into it.
  const phase = session?.phase;
  useEffect(() => {
    if (viewRef.current !== "live") return;
    if (phase !== "gameCreated" && phase !== "clientReady") return;
    setFrame(null);
    setSelectedUnit(null);
    setTelemetry(null);
    setLiveMaxLoop(0);
    loopRef.current = 0;
    setLoop(0);
    lastFetchedLoopRef.current = -1;
    lastFrameAtRef.current = 0;
  }, [phase]);

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
    setLiveMaxLoop(0);
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

  /** Switching what the window shows also switches what main answers from. */
  const switchView = useCallback(
    async (kind: "recording" | "live") => {
      setView(kind);
      viewRef.current = kind;
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

  if (!recording && !live) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          height: "100%",
        }}
      >
        <button onClick={openRecording} style={{ padding: "10px 20px", fontSize: 14 }}>
          Open Recording...
        </button>
        <div style={{ borderTop: "1px solid #2b323d", paddingTop: 20, minWidth: 420 }}>{sessionPanel(false)}</div>
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
          <button onClick={toggleWatch}>{watch ? "Stop Watching" : "Watch Folder..."}</button>
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
            onAttach={attachTelemetry}
            streamCount={streamCount}
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
