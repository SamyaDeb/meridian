# Hallway test (MOBILE_UX_RESEARCH §8, MOBILE_PLAN N8 3b)

**When:** Saturday, before the go/no-go. **Who:** 3 people who don't know the app. **Device:** the Android phone with
the preview APK (staging, **testnet**), freshly installed (no wallet on it). **Time:** 20 minutes per person at most.

## Intro (read aloud; our wording, not from the research)
> "This is an app for trading on Monad. It's test money, nothing real. I'll give you five small tasks. Please think out
> loud: say what you're looking for and what you expect to happen. I can't help you, but there are no wrong answers:
> if you get stuck, that's the app's fault, not yours."

Tasks (research §8, word for word):
1. Make a wallet.
2. Get to a balance.
3. Open a $5 long.
4. Close it.
5. Find where your passkey is saved.

Rules for the facilitator: start the stopwatch when the task is read, stop it when the task is done or abandoned
(3 min cap). Count every tap. Write down each hesitation (≥ 2 s without a tap, or a tap on the wrong thing) and what
they say out loud. Don't point, don't hint. Between tasks 2 and 3 the facilitator may fund the wallet with test AUSD +
MON ("Get test funds") if the person didn't get there; note it.

## Setup checklist
- [ ] Preview APK installed fresh; staging assetlinks has its signer (passkeys work)
- [ ] MM bot running (Meridian book has liquidity) or Perpl setup done on the test wallet (for task 3)
- [ ] Screen recording on (Android quick settings → Screen record, with taps shown)
- [ ] `FLAGS_*` on Vercel staging all unset (no kill switch, no forced update)

## Results

### Person 1 (initials / role: ______)
| Task | Time (s) | Taps | Done? | Hesitations (where, how long) | Said out loud |
|---|---|---|---|---|---|
| 1. Make a wallet | | | | | |
| 2. Get to a balance | | | | | |
| 3. Open a $5 long | | | | | |
| 4. Close it | | | | | |
| 5. Find where your passkey is saved | | | | | |

### Person 2 (initials / role: ______)
| Task | Time (s) | Taps | Done? | Hesitations (where, how long) | Said out loud |
|---|---|---|---|---|---|
| 1. Make a wallet | | | | | |
| 2. Get to a balance | | | | | |
| 3. Open a $5 long | | | | | |
| 4. Close it | | | | | |
| 5. Find where your passkey is saved | | | | | |

### Person 3 (initials / role: ______)
| Task | Time (s) | Taps | Done? | Hesitations (where, how long) | Said out loud |
|---|---|---|---|---|---|
| 1. Make a wallet | | | | | |
| 2. Get to a balance | | | | | |
| 3. Open a $5 long | | | | | |
| 4. Close it | | | | | |
| 5. Find where your passkey is saved | | | | | |

### Targets (MOBILE_PLAN §1.3, research §5.1)
Task 1 ≤ 15 s and 2 taps + fingerprint · tasks 3 + 4 without help · task 5 found from Settings (passkey card).

## Top 3 fixes
(Fill in after the three sessions: the issue, how many of the 3 hit it, the fix, the PR / commit. Fix these before the
release build.)

1.
2.
3.
