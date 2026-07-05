/**
 * Reproduction test for issue #2038: File change entries with icons in message output are not clickable.
 *
 * This test verifies that file entries rendered in chat message output are static <span> elements
 * rather than clickable <button> or <a> elements, confirming the bug exists.
 *
 * Two rendering locations are affected:
 *   1. `TurnChangedFilePills` in `MessageBody.tsx` (inline file pills at the bottom of a turn)
 *   2. `getMultiFileDescription` in `ToolPart.tsx` (inline multi-file rows in tool output)
 *
 * Compare with `ChangedFilesList.tsx` which DOES render files as <button> with onClick handlers.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('File entry clickability in message output (#2038)', () => {
    test('TurnChangedFilePills in MessageBody.tsx uses <span> without onClick for file entries', () => {
        const filePath = __dirname + '/../MessageBody.tsx';
        const code = readFileSync(filePath, 'utf-8');

        // The TurnChangedFilePills component uses TooltipTrigger asChild wrapping a <span>
        // to render each file entry. There is no <button>, <a>, or onClick handler.
        // This confirms the file entries are static display only.
        expect(code.indexOf('TurnChangedFilePills') >= 0).toBe(true);

        // Verify the component uses TooltipTrigger asChild with a <span> child
        expect(code).toContain('<TooltipTrigger asChild>');

        // Verify that within the TurnChangedFilePills component, the file entry 
        // rendering uses <span> and NOT <button>.
        // The JSX inside the .map() callback renders:
        //   <TooltipTrigger asChild>
        //     <span>...</span>            ← NOT a button, NOT clickable
        //   </TooltipTrigger>
        // We verify this by extracting the content between TurnChangedFilePills
        // and the next `const` (types/interfaces follow the component).
        const pillsStart = code.indexOf('const TurnChangedFilePills');
        expect(pillsStart >= 0).toBe(true);

        // The component definition ends at the next `const` keyword at column 0
        // (the definitions after it include: type SubtaskPartLike, type ShellActionPartLike, etc.)
        const pillsEnd = code.indexOf('\nconst ', pillsStart + 1);
        expect(pillsEnd > pillsStart).toBe(true);

        const componentCode = code.slice(pillsStart, pillsEnd);

        // Component should have <TooltipTrigger asChild> with <span> children
        expect(componentCode).toContain('<TooltipTrigger asChild>');
        expect(componentCode).toContain('<span');

        // The file entries are rendered as <span> inside TooltipTrigger.
        // There should be no <button> or onClick in actual file entry rendering.
        // The TooltipTrigger's child is a <span> (not a button).
        expect(componentCode).not.toContain('<button');
        expect(componentCode).not.toContain('onClick');

        // The file pill structure is:
        // <Tooltip key={file.file}>
        //   <TooltipTrigger asChild>
        //     <span> ← static span with FileTypeIcon + filename + diff stats
        //   </TooltipTrigger>
        //   <TooltipContent>{file.file}</TooltipContent>
        // </Tooltip>
        // → Nothing is clickable - no onClick, no role="button", no cursor-pointer
    });

    test('getMultiFileDescription in ToolPart.tsx uses <span> without onClick for per-file entries', () => {
        const filePath = __dirname + '/../parts/ToolPart.tsx';
        const code = readFileSync(filePath, 'utf-8');

        // getMultiFileDescription renders file entries as <span> with FileTypeIcon.
        // There is no <button> or onClick on individual file entries.
        expect(code).toContain('const getMultiFileDescription');

        // Extract just the getMultiFileDescription function.
        // It starts with `const getMultiFileDescription = (` and ends with the 
        // first `};` that belongs to the outer function (after the return).
        // We look from the function start to its enclosing return statement.
        const startIdx = code.indexOf('const getMultiFileDescription');
        expect(startIdx >= 0).toBe(true);

        // Find the JSX return block: return ( ... );
        // The function body contains nested helper functions (parseCount, combineCounts),
        // then the final return statement. We need the outer function's closing `};`.
        const restAfterStart = code.slice(startIdx);
        
        // The outer function ends with `};` after the return statement.
        // We need to find the return statement then the matching semicolon+brace.
        const returnMatch = restAfterStart.match(/return\s*\([\s\S]*?\)\s*;\s*\};/);
        expect(returnMatch).not.toBeNull();
        const fnBody = restAfterStart.slice(0, returnMatch!.index! + returnMatch![0].length);

        // Verify per-file entries render as <span> and not <button>
        expect(fnBody).toContain('<span');
        expect(fnBody).not.toContain('<button');
        expect(fnBody).not.toContain('onClick');

        // The per-file entry JSX:
        // <span key={entry.path} className={cn('inline-flex min-w-0 max-w-full items-center gap-1', ...)}>
        //   {showFileIcons ? <FileTypeIcon filePath={entry.path} ... /> : null}
        //   <Text ...>{entry.name}</Text>
        //   {hasPerFileDiff ? <span>+N/-M</span> : null}
        // </span>
        // → No onClick, no button wrapping
    });

    test('ChangedFilesList.tsx renders files as clickable <button> elements (reference implementation)', () => {
        const filePath = __dirname + '/../../ChangedFilesList.tsx';
        const code = readFileSync(filePath, 'utf-8');

        // ChangedFilesList correctly uses <button> elements with onClick handlers.
        // This is the reference for the correct pattern.
        expect(code).toContain('<button');
        expect(code).toContain('onClick={() => onOpenFile(file)}');
    });

    test('renderAnimatedPathWithIcon in ToolPart.tsx renders file paths as static <span>', () => {
        const filePath = __dirname + '/../parts/ToolPart.tsx';
        const code = readFileSync(filePath, 'utf-8');

        // renderAnimatedPathWithIcon renders file paths as <span> elements.
        // The function name matches the pattern.
        const startIdx = code.indexOf('const renderAnimatedPathWithIcon');
        expect(startIdx >= 0).toBe(true);

        const restAfter = code.slice(startIdx);
        // This function has two return statements (one for no-slash, one with slash).
        // We need to find where it ends. Look for the `};` that closes the outer function.
        // The outer function uses arrow syntax: `const foo = (...) => { ... };`
        // Find the return block then the semicolon+bracket.
        const returnMatch = restAfter.match(/return\s*\([\s\S]*?\)\s*;\s*\};/);
        expect(returnMatch).not.toBeNull();
        const fnBody = restAfter.slice(0, returnMatch!.index! + returnMatch![0].length);

        // Verify only <span> elements used for file paths
        expect(fnBody).toContain('<span');
        expect(fnBody).not.toContain('<button');
    });
});
