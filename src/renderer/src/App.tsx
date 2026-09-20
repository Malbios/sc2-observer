import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameAtLoopIpc, RecordingInfo, TerrainDataIpc, UnitSummaryIpc, UnitTypeInfoIpc } from "../../shared/ipc-types";
import { MapView, type MapViewHandle } from "./components/MapView";
import { Minimap } from "./components/Minimap";
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

  const mapHandleRef = useRef<MapViewHandle | null>(null);
  const loopRef = useRef(0);
  const lastFetchedLoopRef = useRef(-1);

  const openRecording = useCallback(async () => {
    const info = await window.spectator.pickAndOpenRecording();
    if (!info) return;
    setRecording(info);
    setSelectedUnit(null);
    setPlaying(false);
    loopRef.current = 0;
    setLoop(0);
    lastFetchedLoopRef.current = -1;

    const [terrainData, typeInfo] = await Promise.all([window.spectator.getTerrain(), window.spectator.getUnitTypeInfo()]);
    setTerrain(terrainData);
    setUnitTypeInfo(typeInfo);
  }, []);

  // Fetch the frame for the current loop whenever it changes (seek, or a
  // playback tick that crossed to a new integer loop).
  useEffect(() => {
    if (!recording) return;
    if (loop === lastFetchedLoopRef.current) return;
    lastFetchedLoopRef.current = loop;
    let cancelled = false;
    window.spectator.getFrameAtLoop(loop).then((result) => {
      if (!cancelled) setFrame(result);
    });
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
        <button onClick={openRecording} style={{ marginLeft: "auto" }}>
          Open Recording...
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <MapView
            terrain={terrain}
            frame={frame}
            selectedTag={selectedUnit?.tag ?? null}
            onSelectUnit={setSelectedUnit}
            unitTypeInfo={unitTypeInfo}
            mapHandleRef={mapHandleRef}
          />
        </div>

        <div style={{ width: 240, borderLeft: "1px solid #2b323d", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          <Minimap terrain={terrain} frame={frame} onRecenter={handleRecenter} />
          <UnitInspector unit={selectedUnit} unitTypeInfo={unitTypeInfo} />
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
        />
      </div>
    </div>
  );
}
