import { render, screen } from "@testing-library/react-native";
import { colors, dpOfTick, fmtWad, formatValue, Num } from "../ui";

const WAD = 10n ** 18n;

describe("formatValue", () => {
  it("unknown is a dash, zero is zero", async () => {
    expect(formatValue(undefined, "apr")).toBe("—");
    expect(formatValue(0n, "apr")).toBe("0.00%");
    expect(formatValue(0n, "usd")).toBe("0.00");
  });
  it("APR from WAD, sign and minus, truncated toward zero", async () => {
    expect(formatValue(123_456n * 10n ** 12n, "apr", { signed: true })).toBe("+12.34%"); // 0.123456 → 12.3456 %
    expect(formatValue(-5n * 10n ** 15n, "apr", { signed: true })).toBe("−0.50%");
    expect(fmtWad(-1n, 2)).toBe("0.00"); // never "−0.00"
  });
  it("groups thousands and formats blocks", async () => {
    expect(formatValue(1_234_567n * WAD, "usd")).toBe("1,234,567.00");
    expect(formatValue(69_059_070n, "block")).toBe("69,059,070");
  });
  it("price precision follows the tick", async () => {
    expect(dpOfTick(10n ** 15n)).toBe(3);
    expect(dpOfTick(undefined, 4)).toBe(4);
  });
});

describe("<Num>", () => {
  const color = (id: string) => {
    const st = screen.getByTestId(id).props.style as unknown[];
    return (st.flat(3) as ({ color?: string } | null)[]).reduce<string | undefined>((c, x) => x?.color ?? c, undefined);
  };
  it("signed values carry sign and colour; unknown is muted", async () => {
    await render(
      <>
        <Num testID="pos" value={WAD / 10n} kind="apr" signed />
        <Num testID="neg" value={-WAD / 10n} kind="apr" signed />
        <Num testID="unk" value={undefined} kind="apr" signed />
      </>,
    );
    expect(screen.getByTestId("pos")).toHaveTextContent("+10.00%");
    expect(color("pos")).toBe(colors.long);
    expect(screen.getByTestId("neg")).toHaveTextContent("−10.00%");
    expect(color("neg")).toBe(colors.short);
    expect(screen.getByTestId("unk")).toHaveTextContent("—");
    expect(color("unk")).toBe(colors.muted);
  });
  it("stale values are dimmed and say so (also to screen readers)", async () => {
    await render(<Num testID="s" value={WAD} kind="usd" stale label="Mark" />);
    expect(screen.getByTestId("s")).toHaveTextContent("1.00 stale");
    expect(screen.getByTestId("s").props.accessibilityLabel).toBe("Mark: 1.00, stale");
  });
});
