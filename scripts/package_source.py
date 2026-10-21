"""Create a portable source archive without environments, data, or secrets."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
target = root.parent / 'moa-ledger-0.1.0.zip'
excluded = {'.venv', 'node_modules', '.git', '.local', '__pycache__', '.pytest_cache', 'dist', '.vercel', 'data'}

with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        relative = file.relative_to(root)
        if any(part in excluded or part.startswith('.pytest-') for part in relative.parts):
            continue
        if not file.is_file() or file.is_symlink():
            continue
        if file.name.startswith('.env') and file.name != '.env.example':
            continue
        if file.suffix in {'.pyc', '.db', '.sqlite3', '.tsbuildinfo'} or file.name.endswith(('.db-wal','.db-shm')):
            continue
        archive.write(file, Path('household-ledger') / relative)
print(f'Source archive: {target.name} ({target.stat().st_size:,} bytes)')
