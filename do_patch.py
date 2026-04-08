#!/usr/bin/env python3
"""
All-in-one patch for traceit/app.js - 4 fixes
Run from /Users/mogsmini/Documents/traceit/
"""
import re, sys

with open('app.js', 'r') as f:
    src = f.read()

lines = src.split('\n')
print(f"[INFO] Lines: {len(lines)}", file=sys.stderr)

changes_made = []

# ══════════════════════════════════════════════════════════════
# DIAGNOSTIC: find key line numbers
# ══════════════════════════════════════════════════════════════
landmarks = {}
for i, l in enumerate(lines):
    s = l.strip()
    for kw in ['function renderNodes','function updatePanel','function buildPathList',
               'let paths','var paths','parentNi','isChild',
               'paper.view.draw','paper.project.clear',
               'btn-add-node','btn-del-node',
               'addNode','deleteNode','mouseup','keydown',
               'pushHistory','_history','_histIdx',
               'paths.splice','sortable','dragend','onEnd',
               'disabled =','disabled=','.disabled',
               'path-item','path-name','path-label']:
        if kw in s:
            landmarks.setdefault(kw, []).append(i+1)
            print(f"  L{i+1}: {l.rstrip()[:110]}", file=sys.stderr)
            break

print("[INFO] Landmark scan done", file=sys.stderr)
print("[INFO] Summary:", file=sys.stderr)
for k, v in sorted(landmarks.items()):
    print(f"  {k}: {v}", file=sys.stderr)
