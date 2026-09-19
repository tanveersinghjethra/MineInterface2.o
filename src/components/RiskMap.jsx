import React, { useMemo } from 'react';
import {
  Circle, CircleMarker, MapContainer, Polygon, Polyline,
  Popup, Rectangle, TileLayer, Tooltip, useMap,
} from 'react-leaflet';
import { Crosshair, Layers3, Radio, Satellite, Waves } from 'lucide-react';
import { bbox, fmtLatLng, idwGrid, riskZonePolygon, polygonAreaM2 } from '../lib/geo.js';
import { damageClass } from '../lib/analytics.js';

const heatColor = (v) =>
  v >= 0.8 ? '#ff4d5f' : v >= 0.6 ? '#ff8a34' : v >= 0.35 ? '#f5c542' : '#32d583';

const strainColor = (s) => {
  const a = Math.abs(s);
  return a >= 6 ? '#ff4d5f' : a >= 2 ? '#ff8a34' : a >= 0.5 ? '#f5c542' : '#3f5563';
};

/** Keeps the viewport around the mesh whenever the node set changes. */
function FitToMesh({ points }) {
  const map = useMap();
  React.useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(points, { padding: [40, 40], maxZoom: 17 });
  }, [map, points.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function RiskMap({
  site, analyses, links, selectedId, onSelect, mode, onModeChange,
}) {
  const [basemap, setBasemap] = React.useState('street');

  const points = useMemo(
    () => analyses.map((a) => [a.node.install_lat, a.node.install_lng]),
    [analyses]);

  const center = site
    ? [site.centroid_lat, site.centroid_lng]
    : points[0] || [23.748, 86.42];

  // angle of draw: limit of the zone that can be affected by the workings
  const influenceR = site
    ? Number(site.panel_depth_m) * Math.tan((Number(site.angle_of_draw_deg) * Math.PI) / 180)
    : 90;

  const panelRing = useMemo(() => {
    const g = site?.panel_geojson;
    if (!g?.coordinates?.[0]) return null;
    return g.coordinates[0].map(([lng, lat]) => [lat, lng]); // GeoJSON is lng,lat
  }, [site]);

  const grid = useMemo(() => {
    if (!analyses.length) return [];
    const samples = analyses.map((a) => ({
      lat: a.node.install_lat, lng: a.node.install_lng, value: a.score,
    }));
    return idwGrid(samples, bbox(points, 140), 18, 2, 150);
  }, [analyses, points]);

  const zone = useMemo(() => riskZonePolygon(grid, 0.6), [grid]);
  const zoneArea = useMemo(() => (zone ? polygonAreaM2(zone) : 0), [zone]);

  const linkRows = useMemo(() => {
    const byId = Object.fromEntries(analyses.map((a) => [a.nodeId, a.node]));
    return links
      .map((l) => {
        const a = byId[l.node_a];
        const b = byId[l.node_b];
        if (!a || !b) return null;
        return {
          id: l.id,
          positions: [[a.install_lat, a.install_lng], [b.install_lat, b.install_lng]],
          strain: Number(l.strain_mm_per_m) || 0,
          delta: Number(l.delta_mm) || 0,
          a: a.node_code, b: b.node_code,
          rssi: l.rssi_dbm,
        };
      })
      .filter(Boolean);
  }, [links, analyses]);

  return (
    <section className="panel mapPanel">
      <div className="panelHead">
        <div>
          <div className="titleRow">
            <h2>Live deformation map</h2>
            {zone && (
              <span className="zonePill">
                predicted zone {(zoneArea / 10000).toFixed(2)} ha
              </span>
            )}
          </div>
          <small>
            {site ? `${site.name} · depth ${site.panel_depth_m} m · angle of draw ${site.angle_of_draw_deg}°` : '—'}
          </small>
        </div>

        <div className="toggle">
          <button className={mode === 'risk' ? 'active' : ''} onClick={() => onModeChange('risk')}>
            <Layers3 size={13} /> Risk surface
          </button>
          <button className={mode === 'mesh' ? 'active' : ''} onClick={() => onModeChange('mesh')}>
            <Waves size={13} /> Mesh strain
          </button>
          <button className={mode === 'sensors' ? 'active' : ''} onClick={() => onModeChange('sensors')}>
            <Radio size={13} /> Nodes
          </button>
          <button
            className="basemapBtn"
            onClick={() => setBasemap((b) => (b === 'street' ? 'satellite' : 'street'))}
            title="Switch basemap"
          >
            <Satellite size={13} />
          </button>
        </div>
      </div>

      <div className="mapWrap">
        <MapContainer center={center} zoom={16} scrollWheelZoom preferCanvas>
          {basemap === 'street' ? (
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          ) : (
            <TileLayer
              attribution="Tiles &copy; Esri, Maxar, Earthstar Geographics"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
          )}

          <FitToMesh points={points} />

          {/* limit of possible influence from the workings */}
          <Circle
            center={center}
            radius={influenceR}
            pathOptions={{
              color: '#f5a524', weight: 1.4, dashArray: '8 8',
              fillColor: '#f5a524', fillOpacity: 0.03,
            }}
          />

          {panelRing && (
            <Polygon
              positions={panelRing}
              pathOptions={{ color: '#5b7b8c', weight: 1.4, dashArray: '4 6', fillOpacity: 0.04 }}
            >
              <Tooltip sticky>Extracted panel outline</Tooltip>
            </Polygon>
          )}

          {/* interpolated deformation surface */}
          {mode === 'risk' && grid.map((c, i) => (
            <Rectangle
              key={i}
              bounds={c.bounds}
              pathOptions={{
                stroke: false,
                fillColor: heatColor(c.value),
                fillOpacity: 0.1 + c.value * 0.34,
              }}
              interactive={false}
            />
          ))}

          {/* predicted subsidence zone */}
          {mode === 'risk' && zone && (
            <Polygon
              positions={zone}
              pathOptions={{ color: '#ff4d5f', weight: 2, dashArray: '6 4', fillOpacity: 0.06 }}
            >
              <Tooltip sticky>
                Predicted subsidence zone · {(zoneArea / 10000).toFixed(2)} ha
              </Tooltip>
            </Polygon>
          )}

          {/* mesh links coloured by measured strain */}
          {(mode === 'mesh' || mode === 'sensors') && linkRows.map((l) => (
            <Polyline
              key={l.id}
              positions={l.positions}
              pathOptions={{
                color: mode === 'mesh' ? strainColor(l.strain) : '#33475a',
                weight: mode === 'mesh' ? 1.5 + Math.min(4, Math.abs(l.strain) / 2) : 1,
                opacity: mode === 'mesh' ? 0.95 : 0.5,
              }}
            >
              <Tooltip sticky>
                <b>{l.a} ↔ {l.b}</b><br />
                {l.delta >= 0 ? 'separating' : 'compressing'} {Math.abs(l.delta).toFixed(1)} mm<br />
                strain {l.strain.toFixed(2)} mm/m · {damageClass(l.strain)}<br />
                link RSSI {l.rssi} dBm
              </Tooltip>
            </Polyline>
          ))}

          {/* nodes */}
          {analyses.map((a) => {
            const isSel = a.nodeId === selectedId;
            return (
              <CircleMarker
                key={a.nodeId}
                center={[a.node.install_lat, a.node.install_lng]}
                radius={isSel ? 11 : a.node.mesh_role === 'gateway' ? 9 : 7}
                pathOptions={{
                  color: isSel ? '#e8f1f8' : '#0b1116',
                  weight: isSel ? 3 : 2.4,
                  fillColor: a.color,
                  fillOpacity: a.node.status === 'offline' ? 0.25 : 1,
                }}
                eventHandlers={{ click: () => onSelect(a.nodeId) }}
              >
                <Popup>
                  <div className="popup">
                    <b>{a.nodeCode} · {a.severity}</b>
                    <span>Risk score <strong>{a.score.toFixed(2)}</strong></span>
                    <span>Tilt <strong>{a.features.tiltDeltaDeg.toFixed(2)}°</strong></span>
                    <span>Strain <strong>{a.features.strainMmPerM.toFixed(2)} mm/m</strong></span>
                    <span>Displacement <strong>{a.features.displacementMm.toFixed(0)} mm</strong></span>
                    <span>Vibration <strong>{a.features.vibrationG.toFixed(3)} g</strong></span>
                    <span className="popupMuted">{a.node.mesh_role} · {a.node.status}</span>
                  </div>
                </Popup>
                {mode === 'sensors' && (
                  <Tooltip permanent direction="top" offset={[0, -8]} className="nodeTag">
                    {a.nodeCode}
                  </Tooltip>
                )}
              </CircleMarker>
            );
          })}
        </MapContainer>

        <div className="mapLegend">
          <span><i style={{ background: '#32d583' }} /> Low</span>
          <span><i style={{ background: '#f5c542' }} /> Moderate</span>
          <span><i style={{ background: '#ff8a34' }} /> High</span>
          <span><i style={{ background: '#ff4d5f' }} /> Critical</span>
        </div>
        <div className="mapBadge">
          <Crosshair size={13} /> {site ? fmtLatLng(site.centroid_lat, site.centroid_lng) : '—'}
        </div>
      </div>
    </section>
  );
}
