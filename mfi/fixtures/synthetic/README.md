# Synthetic Perpl fixtures

**These are not recorded responses.** They follow the shapes in Perpl's API docs (`github.com/PerplFoundation/api-docs` @ `25ab6e2`, `rest-endpoints.md`, `types.md`); every value (market ids, symbols, decimals, prices, OI, rates) is invented. Each file carries `"_synthetic": true`, which the parser ignores.

The cloud sandbox cannot reach perpl.xyz (egress denied). Record real ones with `pnpm --filter @pulse/mfi record:perpl` (writes `fixtures/recorded/<network>/`), then add replay tests on them and resolve the `> VERIFY` items in `docs/MFI.md` §2.
