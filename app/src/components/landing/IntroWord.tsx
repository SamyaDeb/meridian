// A hero headline word split into per-character spans for the intro scatter animation.
export default function IntroWord({ text }: { text: string }) {
  return (
    <span data-w="1" style={{ display: "inline-block" }}>
      {[...text].map((ch, i) => (
        <span key={i} style={{ display: "inline-block" }}>
          {ch}
        </span>
      ))}
    </span>
  );
}
