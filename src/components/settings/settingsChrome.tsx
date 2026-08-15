// Shared furniture for the settings panel: the row layout both tabs are built
// from, the section label above a group, and the compact select styling that
// keeps the controls in the app's language rather than the library's default.

import { useState } from "react";
import { actionButton } from "../ui/action-button";
import { Switch } from "@/components/ui/switch";

/** Compact select trigger in the app's language (mono, hairline, small). */
export const triggerClass =
  "font-mono tabular-nums inline-flex h-7 items-center justify-between gap-1.5 rounded-lg border border-hairline bg-transparent px-2.5 text-xs text-foreground shadow-none outline-none hover:border-input data-[placeholder]:text-muted-foreground [&>svg]:size-3 [&>svg]:opacity-60";
export const selectContentClass = "min-w-[7rem] rounded-lg border-hairline";
export const selectItemClass = "text-xs py-1.5";

/** One settings row: label block on the left, control(s) pinned right, never
 *  wrapping. `note` is an outcome line that spans the full width underneath. */
export function SettingRow({
  title,
  caption,
  note,
  children,
}: {
  title: string;
  caption?: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-settings-row className='py-[11px]'>
      <div className='flex items-center justify-between gap-5'>
        <div className='min-w-0'>
          <span className='block text-[13.5px] font-semibold text-foreground'>{title}</span>
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

/** Destructive action with inline armed-confirm, using the app's buttons. */
export function DangerAction({
  title,
  caption,
  buttonLabel,
  confirmLabel,
  onRun,
}: {
  title: string;
  caption: string;
  buttonLabel: string;
  confirmLabel: string;
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
        <button className={actionButton("subtle")} onClick={() => setArmed(true)}>
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
