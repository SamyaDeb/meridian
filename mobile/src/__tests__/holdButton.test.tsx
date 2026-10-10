import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { HoldButton } from "../ui";
import { haptic } from "../ui/haptics";

jest.mock("../ui/haptics", () => ({ haptic: { selection: jest.fn(), holdStart: jest.fn(), success: jest.fn(), error: jest.fn() } }));

jest.useFakeTimers();
beforeEach(() => jest.clearAllMocks());

it("completes after a full 600 ms hold (haptic on start and success)", async () => {
  const onConfirm = jest.fn();
  await render(<HoldButton title="Confirm" onConfirm={onConfirm} />);
  await fireEvent(screen.getByRole("button"), "pressIn");
  expect(haptic.holdStart).toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(700));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(haptic.success).toHaveBeenCalledTimes(1);
});

it("releasing early cancels", async () => {
  const onConfirm = jest.fn();
  await render(<HoldButton title="Confirm" onConfirm={onConfirm} />);
  await fireEvent(screen.getByRole("button"), "pressIn");
  await act(async () => jest.advanceTimersByTime(300));
  await fireEvent(screen.getByRole("button"), "pressOut");
  await act(async () => jest.advanceTimersByTime(1_000));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(haptic.success).not.toHaveBeenCalled();
});

it("screen readers confirm with the activate action; disabled does nothing", async () => {
  const onConfirm = jest.fn();
  const { rerender } = await render(<HoldButton title="Confirm" onConfirm={onConfirm} />);
  await fireEvent(screen.getByRole("button"), "accessibilityAction", { nativeEvent: { actionName: "activate" } });
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await rerender(<HoldButton title="Confirm" onConfirm={onConfirm} disabled />);
  await fireEvent(screen.getByRole("button"), "accessibilityAction", { nativeEvent: { actionName: "activate" } });
  await fireEvent(screen.getByRole("button"), "pressIn");
  await act(async () => jest.advanceTimersByTime(1_000));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
