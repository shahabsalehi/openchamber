/**
 * Verification script for Issue #2094
 * 
 * Checks the CSS cascade order of `sticky` vs `relative` utilities
 * in the compiled Tailwind v4 CSS output.
 * 
 * In Tailwind v4, utility classes are alphabetically sorted by default.
 * `relative` comes before `sticky`, so `sticky` wins when both are applied.
 * 
 * Additionally checks how the transform container affects stacking contexts.
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.resolve(__dirname, '../../packages/web/dist/assets');

function verifyCSSOrder() {
  console.log('=== Issue #2094: CSS Cascade Verification ===\n');

  // Find CSS files
  const cssFiles = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.css'));
  
  if (cssFiles.length === 0) {
    console.log('❌ No CSS files found in dist directory. Run "bun run build" first.');
    process.exit(1);
  }

  console.log(`Found ${cssFiles.length} CSS file(s):`);
  cssFiles.forEach(f => console.log(`  - ${f}`));

  let stickyFound = false;
  let relativeFound = false;
  let stickyLine = -1;
  let relativeLine = -1;
  let stickyBeforeRelative = false;

  for (const cssFile of cssFiles) {
    const content = fs.readFileSync(path.join(DIST_DIR, cssFile), 'utf-8');
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('position:sticky') || line.includes('position: sticky')) {
        stickyFound = true;
        stickyLine = i;
        console.log(`\n📄 Found sticky in: ${cssFile}`);
        console.log(`   Line ${i + 1}: ${line.substring(0, 120)}...`);
      }
      if (line.includes('position:relative') || line.includes('.relative{position:relative}')) {
        relativeFound = true;
        relativeLine = i;
        console.log(`\n📄 Found relative in: ${cssFile}`);
        console.log(`   Line ${i + 1}: ${line.substring(0, 120)}...`);
      }
    }
  }

  if (stickyFound && relativeFound) {
    stickyBeforeRelative = stickyLine < relativeLine;
    console.log('\n=== VERDICT ===');
    if (stickyBeforeRelative) {
      console.log('❌ sticky appears BEFORE relative in CSS!');
      console.log('   When both classes are applied, relative would override sticky.');
      console.log('   The user header would NOT be sticky even in the streaming tail (outside transform).');
    } else {
      console.log('✅ sticky appears AFTER relative in CSS (correct).');
      console.log('   sticky correctly overrides relative when both classes are applied.');
    }
    console.log(`   sticky at line ${stickyLine + 1}, relative at line ${relativeLine + 1}`);
  } else if (!stickyFound) {
    console.log('\n⚠️  sticky not found in CSS files - may be inlined or in another chunk');
  } else if (!relativeFound) {
    console.log('\n⚠️  relative not found in CSS files - may be inlined or in another chunk');
  }

  // Check for transform in source files
  console.log('\n\n=== Transform Container Analysis ===');
  
  const messageListPath = path.resolve(__dirname, '../../packages/ui/src/components/chat/MessageList.tsx');
  if (fs.existsSync(messageListPath)) {
    const content = fs.readFileSync(messageListPath, 'utf-8');
    const transformLines = content.split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('transform'));
    
    console.log(`Found ${transformLines.length} transform-related lines in MessageList.tsx:`);
    transformLines.forEach(({ line, text }) => {
      console.log(`  Line ${line}: ${text.trim()}`);
    });
    
    const virtualizerLines = content.split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('translateY'));
    
    console.log(`\nTranslateY (virtualizer offset) instances:`);
    virtualizerLines.forEach(({ line, text }) => {
      console.log(`  Line ${line}: ${text.trim()}`);
    });
  }

  // Check TurnItem.tsx for sticky + relative on same element
  console.log('\n\n=== TurnItem.tsx Analysis ===');
  const turnItemPath = path.resolve(__dirname, '../../packages/ui/src/components/chat/components/TurnItem.tsx');
  if (fs.existsSync(turnItemPath)) {
    const content = fs.readFileSync(turnItemPath, 'utf-8');
    const stickyLines = content.split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('sticky') && text.includes('relative'));
    
    console.log(`Lines with both sticky AND relative on same element:`);
    stickyLines.forEach(({ line, text }) => {
      console.log(`  Line ${line}: ${text.trim()}`);
      if (stickyLines.length > 0) {
        console.log('  ⚠️  This element has both position: sticky AND position: relative!');
      }
    });
  }

  // Check TurnAssistantBlock.tsx
  console.log('\n\n=== TurnAssistantBlock.tsx Analysis ===');
  const assistantBlockPath = path.resolve(__dirname, '../../packages/ui/src/components/chat/components/TurnAssistantBlock.tsx');
  if (fs.existsSync(assistantBlockPath)) {
    const content = fs.readFileSync(assistantBlockPath, 'utf-8');
    const zIndexLines = content.split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => text.includes('z-') || text.includes('zIndex'));
    
    console.log(`z-index declarations:`);
    zIndexLines.forEach(({ line, text }) => {
      console.log(`  Line ${line}: ${text.trim()}`);
    });
  }
}

verifyCSSOrder();
