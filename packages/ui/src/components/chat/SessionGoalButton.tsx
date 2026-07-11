import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { SessionGoalDialog } from '@/components/chat/SessionGoalDialog';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SessionGoalButtonProps {
  sessionId: string | null;
  directory?: string;
  /** Session draft is open — the goal arms for the session the draft creates. */
  draftOpen?: boolean;
  footerIconButtonClass: string;
  iconSizeClass: string;
  withTooltip?: boolean;
}

// Composer target button — the goal switch. With no live goal one tap arms
// goal mode (the next sent prompt becomes the objective; works on drafts
// too) and a second tap disarms. While a goal is live the target stays lit
// (info while running, success when complete, error when blocked / out of
// budget) and tapping opens the manage dialog.
export const SessionGoalButton: React.FC<SessionGoalButtonProps> = React.memo(({
  sessionId,
  directory,
  draftOpen = false,
  footerIconButtonClass,
  iconSizeClass,
  withTooltip = false,
}) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const armed = useSessionGoalArmStore((state) => state.armed);
  const setArmed = useSessionGoalArmStore((state) => state.setArmed);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  // The goal loop runs in the web server; the VS Code extension only renders
  // goal state. Arming a goal there would create one nothing drives, so the
  // entry point is hidden entirely.
  if (isVSCodeRuntime() || !enabled || (!sessionId && !draftOpen)) {
    return null;
  }

  // A settled goal no longer drives the loop — the button goes back to being
  // an arm switch, while still tinting with the outcome color.
  const liveGoal = goal && goal.status !== 'complete' ? goal : null;
  const isEngaged = armed || Boolean(liveGoal);

  const colorClass = (() => {
    if (goal?.status === 'complete') return 'text-[var(--status-success)]';
    if (goal?.status === 'blocked' || goal?.status === 'budgetLimited') return 'text-[var(--status-error)]';
    if (armed || goal?.status === 'active' || goal?.status === 'paused') return 'text-[var(--status-info)]';
    return '';
  })();

  const label = liveGoal
    ? t('chat.goal.button.manageAria')
    : (armed ? t('chat.goal.button.disarmAria') : t('chat.goal.button.armAria'));

  const handleClick = () => {
    if (liveGoal) {
      setDialogOpen(true);
      return;
    }
    setArmed(!armed);
  };

  const button = (
    <button
      type="button"
      className={cn(footerIconButtonClass, colorClass)}
      onClick={handleClick}
      aria-label={label}
      aria-pressed={isEngaged}
      {...(withTooltip ? {} : { title: label })}
    >
      {isEngaged || goal ? (
        <Icon name="target-fill" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
      ) : (
        <Icon name="target" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
      )}
    </button>
  );

  return (
    <>
      {withTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
        </Tooltip>
      ) : button}
      {sessionId ? (
        <SessionGoalDialog open={dialogOpen} onOpenChange={setDialogOpen} sessionId={sessionId} directory={directory} />
      ) : null}
    </>
  );
});

SessionGoalButton.displayName = 'SessionGoalButton';
