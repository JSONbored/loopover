import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  listRampGateTransitions,
  RAMP_GATE_DISPLAY_LABELS,
  type GateRampSettingsSlice,
} from "@/lib/gate-ramp";

type GateRampConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoFullName: string;
  settings: GateRampSettingsSlice;
  busy: boolean;
  onConfirm: () => void;
};

/**
 * Confirmation gate before moving deterministic rules from advisory to blocking (#2218). Lists the exact
 * sub-gates that will change so maintainers know what becomes merge-blocking.
 */
export function GateRampConfirmDialog({
  open,
  onOpenChange,
  repoFullName,
  settings,
  busy,
  onConfirm,
}: GateRampConfirmDialogProps) {
  const transitions = listRampGateTransitions(settings);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Enable blocking gate rules?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left text-token-sm text-muted-foreground">
              <p>
                This updates <span className="font-mono text-foreground/90">{repoFullName}</span>{" "}
                via the same settings mutation as the repository settings editor. Pull requests that
                trip these gates may be blocked from merging once branch protection requires the
                LoopOver check.
              </p>
              {transitions.length > 0 ? (
                <ul className="space-y-1 rounded-token border-hairline bg-muted/20 px-3 py-2 font-mono text-token-2xs">
                  {transitions.map((entry) => (
                    <li key={entry.key}>
                      {RAMP_GATE_DISPLAY_LABELS[entry.key]}: {entry.from} → {entry.to}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>All ramp gates are already blocking.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || transitions.length === 0}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "Saving…" : "Enable blocking"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
