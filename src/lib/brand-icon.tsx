import { ImageResponse } from "next/og";

// The app icon: a small cluster of linked nodes on a dark tile.
export function brandIcon(size: number) {
  const nodes = [
    [0.3, 0.32],
    [0.68, 0.26],
    [0.5, 0.55],
    [0.26, 0.72],
    [0.74, 0.7],
  ];
  const edges = [
    [0, 1],
    [0, 2],
    [1, 2],
    [2, 3],
    [2, 4],
    [3, 4],
  ];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#14141e" }}>
        <svg width={size} height={size} viewBox="0 0 100 100">
          {edges.map(([a, b]) => (
            <line
              key={`${a}-${b}`}
              x1={nodes[a][0] * 100}
              y1={nodes[a][1] * 100}
              x2={nodes[b][0] * 100}
              y2={nodes[b][1] * 100}
              stroke="#9b85ff"
              strokeOpacity={0.6}
              strokeWidth={3}
            />
          ))}
          {nodes.map(([x, y], i) => (
            <circle key={i} cx={x * 100} cy={y * 100} r={i === 2 ? 9 : 6.5} fill={i === 2 ? "#ffffff" : "#9b85ff"} />
          ))}
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
