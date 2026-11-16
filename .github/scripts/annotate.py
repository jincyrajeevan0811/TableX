"""Turn a log file into GitHub check annotations so results are readable from the Checks API.
usage: python annotate.py <file> <title> [error|notice] [tail_chars]"""
import sys

path, title = sys.argv[1], sys.argv[2]
level = sys.argv[3] if len(sys.argv) > 3 else 'error'
tail = int(sys.argv[4]) if len(sys.argv) > 4 else 30000
try:
    text = open(path, encoding='utf-8', errors='replace').read()
except FileNotFoundError:
    text = f'(no {path})'
text = text[-tail:]
chunks = [text[i:i + 3500] for i in range(0, len(text), 3500)][:9] or ['(empty)']
for n, chunk in enumerate(chunks, 1):
    esc = chunk.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print(f'::{level} title={title} [{n}/{len(chunks)}]::{esc}')
