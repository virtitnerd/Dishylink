// Shared furniture for the settings panel: the row layout both tabs are built
// from, the section label above a group, and the compact select styling that
// keeps the controls in the app's language rather than the library's default.

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { actionButton } from "../ui/action-button";
import { Switch } from "@/components/ui/switch";
import { InfoDot } from "../shared/InfoDot";
import type { Severity } from "../ui/severity-icon";

/** Compact select trigger in the app's language (mono, hairline, small). */
export const triggerClass =
  "font-mono tabular-nums inline-flex h-7 items-center justify-between gap-1.5 rounded-lg border border-hairline bg-transparent px-2.5 text-xs text-foreground shadow-none outline-none hover:border-input data-[placeholder]:text-muted-foreground [&>svg]:size-3 [&>svg]:opacity-60";
export const selectContentClass = "min-w-[7rem] rounded-lg border-hairline";
export const selectItemClass = "text-xs py-1.5";

/** One settings row: label block on the left, control(s) pinned right, never
 *  wrapping. `note` is an outcome line that spans the full width underneath.
 *  `info` puts the ⓘ beside the title. */
export function SettingRow({
  title,
  info,
  infoSeverity,
  caption,
  note,
  children,
}: {
  title: string;
  info?: string;
  infoSeverity?: Severity;
  caption?: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-settings-row className='py-[11px]'>
      <div className='flex items-center justify-between gap-5'>
        <div className='min-w-0'>
          <span className='flex items-center gap-1.5 text-[13.5px] font-semibold text-foreground'>
            {title}
            {info && <InfoDot tip={info} severity={infoSeverity} />}
          </span>
          {caption && (
            <span className='mt-px block text-[12px] text-muted-foreground'>{caption}</span>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-2'>{children}</div>
      </div>
      {note && <div className='mt-1.5 text-[12px] text-muted-foreground'>{note}</div>}
    </div>
  );
}

/** Small caps heading over a group of rows (Maintenance, Networks, Mesh nodes). */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-section-label
      className='mt-4 mb-0.5 font-mono text-[10px] font-medium tracking-[0.11em] text-muted-foreground uppercase'
    >
      {children}
    </div>
  );
}

/**
 * A section that stays folded until asked for.
 *
 * For settings that are correct by default and only wanted by the few people the
 * default fails. Folded, it reads as one line the eye skips; a curious click is
 * what it costs to see it, which is the right price for a control that can stop
 * the app finding the hardware.
 */
export function CollapsibleSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div data-collapsible-section className='mt-4'>
      <button
        type='button'
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-1.5 font-mono text-[11px] font-medium tracking-[0.11em] text-muted-foreground uppercase transition-colors hover:text-foreground'
      >
        <ChevronRightIcon
          className={`size-3.5 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        {title}
      </button>
      {open && <div className='mt-0.5'>{children}</div>}
    </div>
  );
}

/** Destructive action with inline armed-confirm, using the app's buttons. */
export function DangerAction({
  title,
  caption,
  buttonLabel,
  confirmLabel,
  disabled = false,
  onRun,
}: {
  title: string;
  caption: string;
  buttonLabel: string;
  confirmLabel: string;
  /** Shown but not runnable, for an action whose device is not answering. */
  disabled?: boolean;
  onRun: () => Promise<string>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  return (
    <SettingRow
      title={title}
      caption={caption}
      note={
        result && (
          <span role='status' className='block'>
            {result}
          </span>
        )
      }
    >
      {!armed ? (
        <button
          className={actionButton("subtle")}
          disabled={disabled}
          onClick={() => setArmed(true)}
        >
          {buttonLabel}
        </button>
      ) : (
        <>
          <button
            className={actionButton("danger")}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setResult(await onRun());
              } catch (error) {
                setResult(`Failed: ${(error as Error).message}`);
              } finally {
                setBusy(false);
                setArmed(false);
              }
            }}
          >
            {busy ? "Sending…" : confirmLabel}
          </button>
          <button
            className={actionButton("subtle")}
            disabled={busy}
            onClick={() => setArmed(false)}
          >
            Cancel
          </button>
        </>
      )}
    </SettingRow>
  );
}

/**
 * A switch where only one direction is dangerous: flipping it that way arms
 * an inline warning + confirm/cancel (same shape as DangerAction) before the
 * write actually fires; flipping it back needs no confirmation.
 */
export function DangerToggle({
  title,
  caption,
  checked,
  disabled,
  dangerousWhen,
  warning,
  confirmLabel,
  onConfirm,
}: {
  title: string;
  caption: string;
  checked: boolean;
  disabled?: boolean;
  /** Which direction (true = turning on) needs the confirm step. */
  dangerousWhen: boolean;
  /** Shown only while arming the dangerous direction. */
  warning: string;
  confirmLabel: string;
  onConfirm: (next: boolean) => Promise<string>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = async (next: boolean) => {
    setBusy(true);
    setArmed(false);
    setResult(null);
    try {
      setResult(await onConfirm(next));
    } catch (error) {
      setResult(`Failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow
        title={title}
        caption={caption}
        note={
          result && (
            <span role='status' className='block'>
              {result}
            </span>
          )
        }
      >
        <Switch
          checked={checked}
          disabled={disabled || busy}
          onCheckedChange={(next) => {
            if (next === dangerousWhen) setArmed(true);
            else void run(next);
          }}
        />
      </SettingRow>
      {armed && (
        <div className='mb-2.5 flex flex-col gap-2 rounded-md border border-status-critical/40 bg-[color-mix(in_srgb,var(--status-critical)_8%,transparent)] p-3'>
          <p className='m-0 text-[12.5px] leading-relaxed text-status-critical'>{warning}</p>
          <div className='flex items-center gap-2'>
            <button
              className={actionButton("danger")}
              disabled={busy}
              onClick={() => void run(dangerousWhen)}
            >
              {busy ? "Sending…" : confirmLabel}
            </button>
            <button
              className={actionButton("subtle")}
              disabled={busy}
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
