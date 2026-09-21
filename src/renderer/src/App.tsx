import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  FrameAtLoopIpc,
  RecordingInfo,
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
import { SnapshotInspector } from "./components/SnapshotInspector";
import { Timeline } from "./components/Timeline";
import { UnitInspector } from "./components/UnitInspector";

/** SC2's normal-speed loop rate: 22.4 game loops per real second. Widely
 * documented across the SC2 AI/ladder tooling community for loop<->time
 * conversion; "1x" playback here means real game speed. */
const LOOPS_PER_SECOND = 22.4;

export function App(): JSX.Element {
  const [recording, setRecording] = useState<RecordingInfo | null>(null);
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

  /**
   * Main's push says only "there is more", so the answer is to re-ask for the
   * loop already on screen. The tailer can announce every poll (~150ms) while
   * a bot is writing, and a channel rebuild plus a whole-game event query at
   * that rate is more than the view needs, so announcements are coalesced.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.spectator.onTelemetryAppended(() => {
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
  useEffect(() => {
    if (!recording) return;
    if (loop === lastFetchedLoopRef.current) return;
    lastFetchedLoopRef.current = loop;
    let cancelled = false;
    Promise.all([window.spectator.getFrameAtLoop(loop), window.spectator.getTelemetryAtLoop(loop)]).then(
      ([frameResult, telemetryResult]) => {
        if (cancelled) return;
        setFrame(frameResult);
        setTelemetry(telemetryResult);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [recording, loop]);

  // Playback loop.
  useEffect(() => {
    if (!playing || !recording) return;
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
  }, [playing, speed, recording]);

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

  if (!recording) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <button onClick={openRecording} style={{ padding: "10px 20px", fontSize: 14 }}>
          Open Recording...
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #2b323d", fontSize: 13, display: "flex", gap: 16 }}>
        <span>{recording.map}</span>
        <span style={{ color: "#8b93a1" }}>mode {recording.mode}</span>
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
              maxLoop={recording.maxLoop}
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
          maxLoop={recording.maxLoop}
          playing={playing}
          speed={speed}
          onSeek={handleSeek}
          onTogglePlay={() => setPlaying((p) => !p)}
          onSpeedChange={setSpeed}
          events={timelineEvents}
        />
      </div>
    </div>
  );
}
