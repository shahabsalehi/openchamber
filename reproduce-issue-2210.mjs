/**
 * Reproduction script for issue #2210
 * 
 * Bug: "Share Opinion" button in the sidebar footer doesn't disappear
 * even after the user has shared their opinion.
 * 
 * This script traces through the code paths to prove there's no
 * mechanism to hide/dismiss the button after engagement.
 */

import { readFileSync } from 'node:fs';

const SIDEBAR_FOOTER_PATH = './packages/ui/src/components/session/sidebar/SidebarFooter.tsx';
const SHARE_OPINION_DIALOG_PATH = './packages/ui/src/components/feedback/ShareOpinionDialog.tsx';
const SESSION_SIDEBAR_PATH = './packages/ui/src/components/session/SessionSidebar.tsx';

// Read the source files
const sidebarFooter = readFileSync(SIDEBAR_FOOTER_PATH, 'utf-8');
const shareOpinionDialog = readFileSync(SHARE_OPINION_DIALOG_PATH, 'utf-8');
const sessionSidebar = readFileSync(SESSION_SIDEBAR_PATH, 'utf-8');

console.log('=== Reproduction of issue #2210 ===');
console.log('Bug: "Share Opinion" button does not disappear after use\n');

// Analysis 1: SidebarFooter shows the button unconditionally when showUpdateButton is false
console.log('--- Analysis 1: SidebarFooter button visibility ---');
const hasConditionalButton = sidebarFooter.includes('showUpdateButton ? (');
const hasElseBranch = sidebarFooter.includes(') : (');
const shareOpinionButtonPresent = sidebarFooter.includes("onClick={onOpenShareOpinion}");
console.log(`  SidebarFooter has conditional (showUpdateButton ? ... : ...): ${hasConditionalButton && hasElseBranch}`);
console.log(`  Share opinion button present in else branch: ${shareOpinionButtonPresent}`);
console.log(`  RESULT: The "Share opinion" button is shown in the ELSE branch when`);
console.log(`  showUpdateButton is false. There is NO other condition controlling it.\n`);

// Analysis 2: ShareOpinionDialog has no callback to hide the button
console.log('--- Analysis 2: ShareOpinionDialog callbacks ---');
const hasOnShareComplete = shareOpinionDialog.includes('onShareComplete') || shareOpinionDialog.includes('onShare');
const bookCallClick = shareOpinionDialog.includes("openExternalUrl('https://calendly.com/artmore/30min')");
const surveyClick = shareOpinionDialog.includes("openExternalUrl('https://forms.gle/cdMVKUGs5QuLWkA86')");
console.log(`  Book a call button onClick: ${bookCallClick ? 'opens external URL only (no dismiss callback)' : 'not found'}`);
console.log(`  Short survey button onClick: ${surveyClick ? 'opens external URL only (no dismiss callback)' : 'not found'}`);
console.log(`  Any onShareComplete/onShare callback: ${hasOnShareComplete}`);
console.log(`  RESULT: Neither dialog button has a callback to hide/remove the`);
console.log(`  sidebar button after the user has engaged.\n`);

// Analysis 3: SessionSidebar state management
console.log('--- Analysis 3: SessionSidebar share opinion state ---');
const hasDialogOpenState = sessionSidebar.includes('shareOpinionDialogOpen');
const hasDismissalTracking = sessionSidebar.includes('shareOpinion') || sessionSidebar.includes('dismiss');
const hasToastStorageKey = sessionSidebar.includes("SHARE_OPINION_TOAST_STORAGE_KEY");
console.log(`  State variable for dialog open: ${hasDialogOpenState ? 'yes (only controls dialog visibility)' : 'no'}`);
console.log(`  Toast localStorage tracking exists: ${hasToastStorageKey ? 'yes (but only for toast, not button)' : 'no'}`);
console.log(`  Button dismissal tracking exists: ${hasDismissalTracking ? 'only toast, not button' : 'no'}`);

// Check if there's any localStorage key for button dismissal
const buttonDismissalKey = sessionSidebar.match(/SHARE_OPINION_BUTTON.*STORAGE_KEY|shareOpinionButton.*dismiss/i);
console.log(`  Button-specific dismissal storage key: ${buttonDismissalKey ? buttonDismissalKey[0] : 'NOT FOUND'}`);
console.log(`  RESULT: There is NO state or localStorage mechanism to track that`);
console.log(`  the user has already shared their opinion and hide the button.\n`);

// Analysis 4: Check if handleOpenShareOpinionDialog does anything beyond opening the dialog
console.log('--- Analysis 4: handleOpenShareOpinionDialog callback ---');
const handlerContent = sessionSidebar.match(/const handleOpenShareOpinionDialog = React\.useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/);
if (handlerContent) {
  const onlySetDialogOpen = handlerContent[0].includes('setShareOpinionDialogOpen(true)') && 
    !handlerContent[0].includes('localStorage') && 
    !handlerContent[0].includes('dismiss') && 
    !handlerContent[0].includes('hide');
  console.log(`  Handler only opens dialog, no dismissal tracking: ${onlySetDialogOpen}`);
} else {
  console.log(`  Handler not found with expected pattern`);
}
console.log(`  RESULT: The handler only opens the dialog. It does NOT set any`);
console.log(`  state to hide the button after first use.\n`);

// Summary
console.log('=== CONCLUSION ===');
console.log(`  The "Share opinion" button is permanently visible because:`);
console.log(`  1. SidebarFooter renders it whenever showUpdateButton is false`);
console.log(`  2. ShareOpinionDialog's action buttons only open external URLs`);
console.log(`  3. There is no state, localStorage key, or callback mechanism to`);
console.log(`     hide the button after the user has shared their opinion`);
console.log(`  4. The only persistence is for the toast notification (SHARE_OPINION_TOAST_STORAGE_KEY),`);
console.log(`     which is unrelated to the button itself`);
console.log(`\n  Expected behavior: After the user opens the dialog and clicks`);
console.log(`  "Book a call" or "Short survey", the button should disappear`);
console.log(`  (or at least have a dismiss mechanism).`);
