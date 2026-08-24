// Whether the Starlink router runs the network at all.
//
// Read from the LAN first and the account last. A router answering locally is one
// bypass has not silenced, which settles it outright; the account carries the same
// fact but was measured lagging a flip by minutes, so trusting it first leaves the
// row insisting on bypass while the WiFi is already back. The dish's own read
// (core/routerPresence.ts) settles it faster still -- it names the role within
// seconds of a flip, well inside the account's minutes-long lag.
//
// Starlink's own support documentation names a factory reset via the router's
// physical reset button as the way out of bypass mode -- no account- or app-side
// undo is documented anywhere. The write below still rides the cloud gateway for
// the "off" direction, because a LAN write has no chance at all once bypassed
// (the router answers nothing locally by definition), so this is strictly the
// only path with any chance of working -- but it is unverified, not a documented
// or guaranteed recovery. If nothing confirms the change, treat that as the
// answer and use the physical button (or the factory reset control) instead of
// waiting further; see SETTLE_TIMEOUT_MS below.

import { useEffect, useState } from "react";
import type { RouterPresence } from "@core/routerPresence";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SlideToConfirm } from "@/components/ui/slide-to-confirm";
import { SpinLoader } from "../loaders/SpinLoader";
import { SettingRow } from "./settingsChrome";

const BYPASS_TIP =
  "Advanced feature that disables the Starlink router completely, so the dish serves a third-party router instead. The Starlink WiFi goes off and the client list, custom DNS and subnet stop working. Starlink's documented way to turn it back off is a factory reset via the router's physical reset button -- most users should leave this off.";

/** The dish names the role within seconds of a flip, so a wait that outlasts this
 *  is one the dish is not going to end. */
const SETTLE_TIMEOUT_MS = 45_000;

export function BypassSection({
  /** What the account reports, or null when its telemetry carries no controller
   *  row to read it from. */
  reported,
  /** The router is answering on the LAN, which only an un-bypassed router does. */
  routerAnswering,
  /** The dish's read on the routers below it, which names the role in seconds
   *  where the account lags a flip by minutes. */
  dishPresence,
  /** No account connected, so the write has nowhere to go. */
  disabled,
  /** Whether the account is answering at all. */
  accountAnswering,
  onSave,
  /** Re-asks the account, the last resort once the dish has not answered. */
  onReload,
}: {
  reported: boolean | null;
  routerAnswering: boolean;
  dishPresence: RouterPresence;
  disabled: boolean;
  accountAnswering: boolean;
  onSave: (enabled: boolean) => Promise<void>;
  onReload: () => void;
}) {
  // The value the open dialog is offering, captured when it opened. The account
  // can catch up while the dialog sits there, and reading the state fresh on
  // accept would send the opposite of the change the dialog named.
  const [offered, setOffered] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // What the last write asked for, outranking an account that keeps reporting the
  // old value for the minutes the router takes to go down or come back.
  const [assumed, setAssumed] = useState<boolean | null>(null);
  // Whether that assumption is still expecting confirmation.
  const [settling, setSettling] = useState(false);

  // Local proof first: the account lags a flip by minutes, and a router answering
  // on the LAN is one no bypass has silenced. One order serves both the display
  // and the wait below, so no signal can end the wait while a stronger one still
  // contradicts it.
  // `absent` is no evidence either way: a router that is off is not a bypassed one.
  const dishSays = dishPresence === "bypassed" ? true : dishPresence === "present" ? false : null;
  const known = (routerAnswering ? false : null) ?? dishSays ?? reported;
  const bypassed = assumed ?? known;
  // Off is the safe direction when the state is unknown, and a no-op if already off.
  const target = bypassed === null ? false : !bypassed;
  // What the control depicts. While a dialog is open it depicts what that dialog
  // offered, so nothing shifts underneath the question being asked.
  const shown = offered ?? target;

  // The account catching up arrives as a prop change, so the wait ends during
  // render rather than from an effect chasing it.
  // The note is cleared rather than replaced with a confirmation: once the state
  // has settled, the badge and the caption both say it, and a third sentence
  // saying it again is the only thing left to read.
  if (assumed !== null && known === assumed) {
    setAssumed(null);
    setSettling(false);
    setNote(null);
  }
  // Chained, because a state update in render does not change what this pass
  // already read: settling on the dish and losing the account in the same pass
  // would otherwise clear the note and then write this one over it.
  //
  // Nothing can confirm through an account this device can no longer reach, and
  // `assumed` outlives the wait so the row keeps offering the way back.
  else if (settling && assumed === true && !accountAnswering) {
    setSettling(false);
    setNote(
      "Sent. This device can't reach your Starlink account now, so nothing here can confirm it.",
    );
  }

  useEffect(() => {
    if (!settling) return;
    const giveUp = setTimeout(() => {
      setAssumed(null);
      setSettling(false);
      setNote(
        "Couldn't confirm the change from here. Use the router's physical reset button if bypass " +
          "needs to come off, or reopen this panel to check again.",
      );
      // Asked once on the way out rather than polled throughout: the account is
      // the only thing left to ask, and it is the slowest of the three.
      onReload();
    }, SETTLE_TIMEOUT_MS);
    return () => clearTimeout(giveUp);
  }, [settling, onReload]);

  const caption = disabled
    ? // A router answering locally settles it: bypass is off, and this row is
      // behind the same account gate as the ones above it, nothing more. Only
      // when the router is silent can bypass be the reason, and then the way
      // back is what the caption has to name.
      bypassed === false
      ? "Connect your Starlink account to use this"
      : "Connect this device to the internet and sign in your account to use"
    : bypassed === null
      ? "Couldn't tell whether the router is bypassed"
      : bypassed
        ? "The Starlink router is disabled; a third-party router runs the network"
        : "The Starlink router is running your network";

  const applyBypass = async (value: boolean) => {
    // Batched with the flag below, so the slider never sees both go false and
    // snap the handle back while the write is in flight.
    setOffered(null);
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      await onSave(value);
      // Deliberately "sent", not "applied": a write that takes effect can kill
      // its own reply, and a reply that arrives cleanly is only ever ACCEPTED,
      // which the router also returns for changes it goes on to discard.
      setNote(
        value
          ? "Sent. The Starlink WiFi is going down; waiting to confirm."
          : "Sent! Attempting to bring the router back through your account; waiting to confirm.",
      );
      setAssumed(value);
      setSettling(true);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingRow
        title='Bypass mode'
        info={BYPASS_TIP}
        infoSeverity='danger'
        caption={caption}
        note={
          <>
            {note && (
              <span role='status' className='block'>
                {note}
              </span>
            )}
            {error && <span className='block text-destructive'>{error}</span>}
          </>
        }
      >
        {settling ? (
          <SpinLoader size={15} label={assumed ? "Turning bypass on" : "Turning bypass off"} />
        ) : (
          bypassed !== null && (
            <Badge tone={bypassed ? "critical" : "neutral"}>{bypassed ? "On" : "Off"}</Badge>
          )
        )}
      </SettingRow>

      <div className='flex flex-col gap-2.5 pb-2'>
        <SlideToConfirm
          label={shown ? "Slide to turn on bypass mode" : "Slide to turn off bypass mode"}
          busyLabel={saving ? "Sending…" : "Confirm to continue"}
          direction={shown ? "right" : "left"}
          tone={shown ? "danger" : "default"}
          // A flip is unresolved until the dish or the account says otherwise, and
          // the opposite write sent into that window races the one already out.
          disabled={disabled || settling}
          busy={offered !== null || saving}
          onConfirm={() => setOffered(target)}
        />
        {/* A tinted box is the app's colour for "something is broken"; this is a
            standing description of what the control does. The icon carries the
            weight instead, which is what it is separately severable for. */}
        <Callout tone='info' icon='warning' iconSeverity={bypassed === false ? "danger" : "normal"}>
          {bypassed === false
            ? "Bypass mode will completely disable the Starlink router and its WiFi. Only a third-party router wired to the dish stays online. Starlink's documented way back is a factory reset via the router's physical reset button -- this panel can attempt to reverse it through your account, but that isn't a documented or guaranteed recovery path."
            : bypassed
              ? "Bypass is on, so the Starlink router is disabled and a third-party router runs your network. This will attempt to bring the Starlink router and its WiFi back through your account. If it doesn't take, use the router's physical reset button instead -- that's Starlink's documented way out."
              : "Can't tell whether bypass is on. Turning it off is the safe direction either way: it attempts to bring the Starlink router and its WiFi back, and changes nothing if bypass was already off."}
        </Callout>
      </div>

      <Dialog open={offered !== null} onOpenChange={(open) => !open && setOffered(null)}>
        <DialogContent
          showCloseButton={false}
          className='glass-panel gap-3 sm:max-w-md'
          overlayClassName='bg-black/30 backdrop-blur-[2px]'
        >
          <DialogHeader>
            <DialogTitle className='text-[19px] leading-snug'>Are you sure?</DialogTitle>
            <DialogDescription className='text-[13.5px] leading-relaxed'>
              {offered
                ? "The Starlink router and its WiFi will switch off. Only devices behind a third-party router wired to the dish stay online. Starlink's documented way back is a factory reset via the router's physical reset button -- this app can attempt to reverse it through your account afterward, but that isn't a documented or guaranteed recovery path."
                : "This attempts to bring the Starlink router and its WiFi back through your account. If it doesn't take, use the router's physical reset button instead -- that's Starlink's documented way out of bypass mode."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className='mt-2 gap-2'>
            <Button
              variant='outline'
              className='cursor-pointer sm:min-w-28'
              disabled={saving}
              onClick={() => setOffered(null)}
            >
              Cancel
            </Button>
            <Button
              variant={offered ? "destructive" : "default"}
              className='cursor-pointer sm:min-w-28'
              disabled={saving}
              onClick={() => offered !== null && void applyBypass(offered)}
            >
              {saving ? "Sending…" : offered ? "Turn on" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
