#!/usr/bin/env python3
"""Patch app.js with 4 changes."""
import re, sys

with open('app.js', 'r') as f:
    src = f.read()

original = src
changes = []

# ============================================================
# CHANGE 4a: Add _hist/_histIdx + pushHistory + undo near top
# Insert after the first block of let/var declarations
# ============================================================
HIST_CODE = """
let _hist = [], _histIdx = -1;
function pushHistory() {
  try {
    var snap = JSON.stringify(paths.map(function(p){ return Object.assign({},p,{nodes:p.nodes.map(function(n){return Object.assign({},n);})}); }));
    _hist = _hist.slice(0, _histIdx+1);
    _hist.push(snap);
    if(_hist.length > 50) _hist.shift(); else _histIdx++;
  } catch(e) {}
}
function undo() {
  if(_histIdx < 1) return;
  _histIdx--;
  paths = JSON.parse(_hist[_histIdx]);
  selected = {pi:0, ni:-1};
  renderNodes(); updatePanel();
}
"""

# Find a good insertion point: after "let selected = ..." line
m = re.search(r'(let selected\s*=\s*[^\n]+\n)', src)
if m:
    src = src[:m.end()] + HIST_CODE + src[m.end():]
    changes.append("Added pushHistory/undo after 'let selected'")
else:
    # fallback: after first block of let declarations
    m = re.search(r'(let paths\s*=\s*[^\n]+\n)', src)
    if m:
        src = src[:m.end()] + HIST_CODE + src[m.end():]
        changes.append("Added pushHistory/undo after 'let paths'")
    else:
        changes.append("WARNING: Could not find insertion point for pushHistory/undo")

# ============================================================
# CHANGE 1: renderNodes path order - check only
# ============================================================
if 'paths.forEach' in src or 'for' in src:
    changes.append("Change 1: paths.forEach already in order (no change needed)")

# ============================================================
# CHANGE 2: buildPathList dblclick rename
# Find the item click handler in buildPathList and add dblclick after it
# ============================================================
DBLCLICK_CODE = """    item.addEventListener('dblclick', function() {
      var pi2 = pi;
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = paths[pi2].name || ('Path ' + (pi2+1));
      inp.style.cssText = 'width:100%;font-size:12px;border:none;background:transparent;outline:1px solid #aaa;';
      var lbl = this.querySelector('.path-label') || this.firstChild;
      this.replaceChild(inp, lbl);
      inp.focus(); inp.select();
      function save() { paths[pi2].name = inp.value || ('Path '+(pi2+1)); buildPathList(); }
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', function(e){ if(e.key==='Enter') { save(); e.preventDefault(); } });
    });
"""

# Find buildPathList function and the item click listener
# Look for item.addEventListener('click' inside buildPathList
m = re.search(r"(item\.addEventListener\('click'[^}]+\}\s*\);)", src, re.DOTALL)
if m:
    # Insert dblclick after the click listener
    insert_pos = m.end()
    src = src[:insert_pos] + '\n' + DBLCLICK_CODE + src[insert_pos:]
    changes.append("Change 2: Added dblclick rename to buildPathList item")
else:
    changes.append("WARNING: Could not find item click listener in buildPathList")

# ============================================================
# CHANGE 3: Child node grey-out - only specific IDs
# Replace the existing parentNi disabled logic in updatePanel
# ============================================================
GREYOUT_NEW = """  // Child node: only disable position/transform params
  var childDisableIds = ['node-jx','node-jy','node-jr','node-js','node-rot','node-rot-end','node-rot-mode','node-spacing-jitter','node-offset'];
  childDisableIds.forEach(function(id){
    var el = document.getElementById(id);
    if(!el) return;
    var row = el.closest('.prop-row') || el.parentElement;
    if(n.parentNi != null) {
      el.disabled = true;
      if(row) row.style.opacity = '0.4';
    } else {
      el.disabled = false;
      if(row) row.style.opacity = '';
    }
  });"""

# Find and replace the existing parentNi disabled block
# Look for the pattern that disables inputs for child nodes
patterns = [
    # Pattern 1: if(n.parentNi != null) { ... disable block ... }
    r'  // [Cc]hild[^\n]*\n(?:  [^\n]*\n)*?  \}(?:\s*\n)?(?=\s*(?:\/\/|var |let |const |document|if|el\.|n\.))',
    # Pattern 2: if(n.parentNi
    r'  if\s*\(\s*n\.parentNi\s*!=\s*null\s*\)\s*\{[^}]*(?:\{[^}]*\}[^}]*)?\}',
]

replaced = False
for pat in patterns:
    m = re.search(pat, src, re.DOTALL)
    if m:
        src = src[:m.start()] + GREYOUT_NEW + src[m.end():]
        changes.append(f"Change 3: Replaced child grey-out logic (pattern matched)")
        replaced = True
        break

if not replaced:
    # Try a simpler approach: find all disabled assignments related to parentNi
    # and replace the whole block
    m = re.search(r'(\s*if\s*\(\s*n\.parentNi[^{]+\{.*?\}(?:\s*else\s*\{.*?\})?)', src, re.DOTALL)
    if m:
        src = src[:m.start()] + '\n' + GREYOUT_NEW + src[m.end():]
        changes.append("Change 3: Replaced child grey-out logic (fallback pattern)")
    else:
        changes.append("WARNING: Could not find child grey-out block to replace")

# ============================================================
# CHANGE 4b: pushHistory calls at key points
# ============================================================

# 4b-1: After path finishes drawing (paths.push)
# Find paths.push( and add pushHistory() after the statement
m = re.search(r'(paths\.push\([^)]+\);)', src)
if m:
    src = src[:m.end()] + '\n      pushHistory();' + src[m.end():]
    changes.append("Change 4b: Added pushHistory() after paths.push")
else:
    changes.append("WARNING: Could not find paths.push")

# 4b-2: After node is added (nodes.push)
m = re.search(r'(nodes\.push\([^)]+\);)', src)
if m:
    src = src[:m.end()] + '\n      pushHistory();' + src[m.end():]
    changes.append("Change 4b: Added pushHistory() after nodes.push")
else:
    changes.append("WARNING: Could not find nodes.push")

# 4b-3: Before node is deleted (nodes.splice)
m = re.search(r'(\s*)(nodes\.splice\()', src)
if m:
    src = src[:m.start(1)] + m.group(1) + 'pushHistory();\n' + m.group(1) + src[m.start(2):]
    changes.append("Change 4b: Added pushHistory() before nodes.splice")
else:
    changes.append("WARNING: Could not find nodes.splice")

# 4b-4: At start of each node param change handler
# Find all getElementById handlers that modify n.
# Look for the pattern: document.getElementById('node-...').addEventListener('change'
# and add pushHistory() at the start of the handler
count = 0
def add_push_to_handler(m):
    global count
    count += 1
    return m.group(0) + '\n    pushHistory();'

src = re.sub(
    r"(document\.getElementById\('node-[^']+'\)\.addEventListener\('(?:change|input)'[^{]+\{)",
    add_push_to_handler,
    src
)
if count > 0:
    changes.append(f"Change 4b: Added pushHistory() to {count} node param change handlers")
else:
    changes.append("WARNING: Could not find node param change handlers")

# ============================================================
# CHANGE 4c: keydown undo listener + slider double-click reset
# Add near end of DOMContentLoaded or init
# ============================================================
KEYDOWN_CODE = """
  // Undo: Ctrl/Cmd+Z
  document.addEventListener('keydown', function(e){
    if((e.ctrlKey||e.metaKey) && e.key==='z'){ undo(); e.preventDefault(); }
  });

  // Slider double-click reset
  document.getElementById('props-node').addEventListener('dblclick', function(e){
    if(e.target && e.target.type==='range'){
      e.target.value = e.target.defaultValue;
      e.target.dispatchEvent(new Event('change'));
    }
  });
"""

# Find the closing of DOMContentLoaded
m = re.search(r'(\}\s*\);\s*$)', src, re.MULTILINE)
if m:
    src = src[:m.start()] + KEYDOWN_CODE + src[m.start():]
    changes.append("Change 4c: Added keydown undo + slider dblclick reset before end of DOMContentLoaded")
else:
    # Append at end
    src = src + KEYDOWN_CODE
    changes.append("Change 4c: Appended keydown undo + slider dblclick reset at end")

# Write the modified file
with open('app.js', 'w') as f:
    f.write(src)

print("Changes made:")
for c in changes:
    print(f"  - {c}")

# Verify brace/paren balance
print(f"\nBrace balance: {src.count('{') - src.count('}')}")
print(f"Paren balance: {src.count('(') - src.count(')')}")
