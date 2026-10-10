// A block tick must re-render only the leaves that read the block, never their siblings or the screen.
import { act, render } from "@testing-library/react-native";
import { Profiler, type ReactNode } from "react";
import { Text } from "react-native";
import { useBlockNumber, useLiveness } from "../live/hooks";
import { LiveProvider } from "../live/LiveProvider";
import { fakeLive } from "./fakeLive";

function BlockLeaf() {
  const b = useBlockNumber();
  return <Text>{b?.toString() ?? "—"}</Text>;
}
function LivenessLeaf() {
  return <Text>{useLiveness()}</Text>;
}

it("a new block re-renders the block leaf only", async () => {
  const { live, blocks, timer } = fakeLive();
  const counts: Record<string, number> = {};
  const P = ({ id, children }: { id: string; children: ReactNode }) => (
    <Profiler id={id} onRender={() => void (counts[id] = (counts[id] ?? 0) + 1)}>
      {children}
    </Profiler>
  );
  await render(
    <LiveProvider live={live}>
      <P id="block">
        <BlockLeaf />
      </P>
      <P id="liveness">
        <LivenessLeaf />
      </P>
      <P id="static">
        <Text>static</Text>
      </P>
    </LiveProvider>,
  );
  await act(async () => blocks.observe(100n)); // first head flips liveness waiting → live
  const after1 = { ...counts };
  await act(async () => {
    timer.tick(400);
    blocks.observe(101n);
  });
  await act(async () => {
    timer.tick(400);
    blocks.observe(102n);
  });
  expect(counts.block).toBe((after1.block ?? 0) + 2);
  expect(counts.liveness).toBe(after1.liveness);
  expect(counts.static).toBe(after1.static);
});
