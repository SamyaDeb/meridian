// A heading line split into per-character spans for the scroll-in "typing" effect.
// Characters start hidden; useLandingAnimations reveals them.
export default function TypeLine({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <span data-t="1">
      {words.map((word, wi) => (
        <span key={wi}>
          <span style={{ display: "inline-block", whiteSpace: "nowrap" }}>
            {[...word].map((ch, ci) => (
              <span key={ci} data-ch="1" style={{ opacity: 0 }}>
                {ch}
              </span>
            ))}
          </span>
          {wi < words.length - 1 ? " " : null}
        </span>
      ))}
    </span>
  );
}
