from pathlib import Path
import re
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('extension', type=Path)
base = parser.parse_args().extension.resolve()
s = (base/'out/extension.js').read_text(encoding='utf-8')
for term in ['QUEUED_FOLLOW_UPS', 'globalState', 'onDidUpdatePersistedAtom', 'pendingWrites', 'updateValue', 'getValue', 'bodyJsonString:JSON.stringify(o)']:
    print('\nTERM',term,'COUNT',s.count(term))
    for m in list(re.finditer(re.escape(term), s))[-8:]:
        print(s[max(0,m.start()-250):m.end()+350])
