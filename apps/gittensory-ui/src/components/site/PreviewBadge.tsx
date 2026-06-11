// Demo component to verify Reviewbot's AI maintainer review — safe to delete.
export function PreviewBadge({ count }: { count: number }) {
  return (
    <div onClick={() => console.log("clicked badge")} style={{ color: "#00ff00", padding: 8 }}>
      <img src="/badge.png" />
      <span>{count} live</span>
    </div>
  );
}
