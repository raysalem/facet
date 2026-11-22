"""Seed a throwaway Facet library for the browser flows, then (with ``serve``) start the viewer on it.

No models and no scan: the photos are synthetic solid-colour images and their rows are written
straight into a database built by ``db.schema.init_database``, the same schema the scanner uses.
Each flow owns its own folder, and a flow that changes its folder resets it first (``reset``), so
flows never depend on one another's changes, nor on an earlier run of themselves.

    python client/e2e/seed_library.py serve --port 5099 --edition-password <pw>   # seed .work, run the viewer
    python client/e2e/seed_library.py reset <folder>                   # restore one folder as seeded
    python client/e2e/seed_library.py reimport <edit_path> <#rrggbb>   # see reimport() below
"""

import argparse
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WORK = os.path.join(REPO, 'client', 'e2e', '.work')
LIBRARY = os.path.join(WORK, 'library')
DB_PATH = os.path.join(WORK, 'facet_e2e.db')
CONFIG_PATH = os.path.join(WORK, 'scoring_config.json')
# send2trash honours XDG_DATA_HOME: a deleted test photo lands here, not in the user's own Trash.
XDG_DATA_HOME = os.path.join(WORK, 'xdg-data')
# The add-on's own page is served here (by serve()), one port above the default viewer port.
ADDON_UI_PORT = int(os.environ.get('FACET_E2E_ADDON_PORT', '5100'))

sys.path.insert(0, REPO)

# folder -> [(file name, colour, aggregate, burst lead, AI edit of)]. One burst per folder.
PHOTOS = {
    # 01 strip + 02 hide bursts (read-only): the edit outscores both frames and leads.
    'burst': [('IMG_0001.jpg', '#3c6e47', 5.0, 0, None),
              ('IMG_0002.jpg', '#6e5a3c', 4.0, 0, None),
              ('IMG_0001_agy_1.jpg', '#2f9e44', 6.0, 1, 'IMG_0001.jpg')],
    # 03 reused name: the red edit is deleted and a blue one imported under the same name.
    # The red edit leads, so its card is in the gallery under Hide bursts.
    'reuse': [('IMG_0100.jpg', '#888888', 5.0, 0, None),
              ('IMG_0100_agy_1.jpg', '#e03131', 6.0, 1, 'IMG_0100.jpg')],
    # 04 lead delete: the edit leads; deleting it must hand the lead to IMG_0200.
    'lead': [('IMG_0200.jpg', '#1971c2', 5.0, 0, None),
             ('IMG_0201.jpg', '#5f3dc4', 3.0, 0, None),
             ('IMG_0200_agy_1.jpg', '#f08c00', 7.0, 1, 'IMG_0200.jpg')],
}
DATE = {'burst': '2026:01:10 10:00:', 'reuse': '2026:01:11 10:00:', 'lead': '2026:01:12 10:00:',
        'album_a': '2026:01:13 10:00:', 'album_b': '2026:01:14 10:00:', 'layout': '2026:01:15 10:00:',
        'tagged': '2026:01:16 10:00:'}
# folder -> (album name, colour, file prefix). Read-only: two manual albums with disjoint photos,
# each photo its own one-frame burst so Hide bursts folds nothing. (album-switch flow)
ALBUMS = {'album_a': ('E2E Album A', '#c92a2a', 'ALB_A'),
          'album_b': ('E2E Album B', '#1864ab', 'ALB_B')}
ALBUM_SIZE = 6
# Tag-kinds + Showing flows (read-only): one album of six photos filed in two sets by album tags, whose
# first photo carries all four tag kinds (AI tags, a named person, an add-on's object tag, album tags).
TAGGED_ALBUM = 'E2E Tagged'
TAGGED_SETS = ('e2e/church', 'e2e/lunch')   # album tags; the picker labels them by their last segment
TAGGED_AI_TAGS = ('sunset', 'beach')
TAGGED_OWN_TAG = 'family'
TAGGED_OBJECT_TAG = 'cup'
TAGGED_PERSON = 'Alex Example'
ADDON_ID = 'e2e-addon'

# Layout geometry flow (read-only): one manual album with enough photos to overflow the grid, each
# its own one-frame burst; the best-scored one carries LAYOUT_TAG_COUNT tags for the hover card.
LAYOUT_ALBUM, LAYOUT_SIZE, LAYOUT_TAG_COUNT, LAYOUT_PEOPLE = 'E2E Layout', 80, 20, 7
LAYOUT_CAMERA = 'E2E Camera Company Professional Mirrorless Full Frame Body Model Number One Hundred Twenty Three'
LAYOUT_CAPTION = ('A long caption that keeps going well past the width of the picture it describes, so that a caption '
                  'line which could widen the floating card would do so: ' + 'words ' * 30).strip()


def _jpeg(colour, size):
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', size, colour).save(buf, 'JPEG', quality=90)
    return buf.getvalue()


def _histogram(thumbnail):
    """The scanner's own histogram for the photo page's RGB widget (every scanned row has one)."""
    import cv2
    import numpy as np
    from analyzers.technical import TechnicalAnalyzer
    image = cv2.imdecode(np.frombuffer(thumbnail, np.uint8), cv2.IMREAD_COLOR)
    return TechnicalAnalyzer.get_histogram_data(image)['histogram_bytes']


def _insert_photo(conn, folder, name, colour, aggregate, lead, group, second):
    path = os.path.join(LIBRARY, folder, name)
    with open(path, 'wb') as fh:
        fh.write(_jpeg(colour, (1200, 800)))
    thumbnail = _jpeg(colour, (640, 427))
    conn.execute(
        'INSERT OR REPLACE INTO photos (path, filename, thumbnail, histogram_data, image_width, image_height, '
        'aggregate, aesthetic, category, date_taken, burst_group_id, is_burst_lead, phash, scanned_at) '
        "VALUES (?, ?, ?, ?, 1200, 800, ?, ?, 'default', ?, ?, ?, ?, datetime('now'))",
        (path, name, thumbnail, _histogram(thumbnail), aggregate, aggregate, DATE[folder] + f'{second:02d}',
         group, lead, f'{group:016x}'))
    return path


def _seed_folder(conn, folder):
    group = list(PHOTOS).index(folder) + 1
    photos = PHOTOS[folder]
    os.makedirs(os.path.join(LIBRARY, folder))
    for second, (name, colour, aggregate, lead, _) in enumerate(photos):
        _insert_photo(conn, folder, name, colour, aggregate, lead, group, second)
    for revision, (name, _, _, _, source) in enumerate((p for p in photos if p[4]), start=1):
        conn.execute('INSERT INTO photo_ai_edits (edit_path, source_path, tool, note, revision, captioned) '
                     "VALUES (?, ?, 'antigravity-gemini', 'e2e edit', ?, 1)",
                     (os.path.join(LIBRARY, folder, name), os.path.join(LIBRARY, folder, source), revision))


def _seed_layout(conn):
    os.makedirs(os.path.join(LIBRARY, 'layout'))
    album_id = conn.execute('INSERT INTO albums (user_id, name) VALUES (NULL, ?)', (LAYOUT_ALBUM,)).lastrowid
    for i in range(LAYOUT_SIZE):
        # Scored below every other folder (the plain gallery's first page stays theirs); LAY_001\n        # scores highest of the album, so it is its first card under the default (score) sort.
        path = _insert_photo(conn, 'layout', f'LAY_{i + 1:03d}.jpg', '#5c7cfa' if i else '#e8590c',
                             2.0 - i * 0.01, 1, 1000 + i, i % 60)
        conn.execute('INSERT INTO album_photos (album_id, photo_path, position) VALUES (?, ?, ?)',
                     (album_id, path, i))
    # The API sends at most display.tags_per_photo (4) AI tags, so the rest are the user's own tags,
    # which all arrive: 20 tags on the card, as on a real library's well-tagged photo.
    tags = [f'tag{n:02d}' for n in range(1, LAYOUT_TAG_COUNT + 1)]
    first = os.path.join(LIBRARY, 'layout', 'LAY_001.jpg')
    conn.execute('UPDATE photos SET tags = ? WHERE path = ?', (', '.join(tags[:4]), first))
    conn.executemany('INSERT INTO photo_tags (photo_path, tag) VALUES (?, ?)', [(first, t) for t in tags[:4]])
    conn.executemany("INSERT INTO photo_manual_tags (photo_path, tag, source) VALUES (?, ?, 'user')",
                     [(first, t) for t in tags[4:]])
    # The rest of what the floating card shows, long enough to stretch it if a row could: a capture line
    # (camera, lens settings), a caption, and 7 named people.
    conn.execute('UPDATE photos SET camera_model = ?, focal_length = 35, f_stop = 1.8, iso = 400, caption = ? '
                 'WHERE path = ?', (LAYOUT_CAMERA, LAYOUT_CAPTION, first))
    for n in range(LAYOUT_PEOPLE):
        _add_person(conn, first, f'Person {n + 1}', n)


def _seed_album(conn, folder):
    name, colour, prefix = ALBUMS[folder]
    os.makedirs(os.path.join(LIBRARY, folder))
    album_id = conn.execute('INSERT INTO albums (user_id, name) VALUES (NULL, ?)', (name,)).lastrowid
    base = 100 * (list(ALBUMS).index(folder) + 1)
    for i in range(ALBUM_SIZE):
        path = _insert_photo(conn, folder, f'{prefix}_{i + 1:02d}.jpg', colour, 5.0, 1, base + i, i)
        conn.execute('INSERT INTO album_photos (album_id, photo_path, position) VALUES (?, ?, ?)',
                     (album_id, path, i))


def _add_person(conn, photo_path, name, face_index):
    """A named person with one face on the photo (the avatar needs the person's thumbnail)."""
    thumbnail = _jpeg('#868e96', (96, 96))
    conn.execute('INSERT INTO persons (name, face_count, auto_clustered, face_thumbnail) VALUES (?, 1, 0, ?)',
                 (name, thumbnail))
    person_id = conn.execute('SELECT max(id) FROM persons').fetchone()[0]
    conn.execute('INSERT INTO faces (photo_path, face_index, embedding, bbox_x1, bbox_y1, bbox_x2, bbox_y2, '
                 'confidence, person_id, face_thumbnail) VALUES (?, ?, ?, 400, 200, 700, 500, 0.99, ?, ?)',
                 (photo_path, face_index, b'\0' * 2048, person_id, thumbnail))


def _seed_tagged(conn):
    os.makedirs(os.path.join(LIBRARY, 'tagged'))
    album_id = conn.execute('INSERT INTO albums (user_id, name) VALUES (NULL, ?)', (TAGGED_ALBUM,)).lastrowid
    colours = ['#e67700', '#2b8a3e', '#1c7ed6', '#9c36b5', '#c2255c', '#0c8599']
    paths = []
    for i in range(6):
        path = _insert_photo(conn, 'tagged', f'TAG_{i + 1:02d}.jpg', colours[i], 5.0 - i * 0.1, 1, 300 + i, i)
        conn.execute('INSERT INTO album_photos (album_id, photo_path, position) VALUES (?, ?, ?)',
                     (album_id, path, i))
        paths.append(path)
    # Album tags are manual tags the registry marks as filing: three photos per set.
    for tag in TAGGED_SETS:
        conn.execute('INSERT INTO album_tags (tag) VALUES (?)', (tag,))
    for i, path in enumerate(paths):
        conn.execute("INSERT INTO photo_manual_tags (photo_path, tag, source) VALUES (?, ?, 'user')",
                     (path, TAGGED_SETS[i // 3]))
    first = paths[0]
    # Tags: the AI's (photos.tags, which the API cuts to display.tags_per_photo) and one the user typed.
    conn.execute('UPDATE photos SET tags = ? WHERE path = ?', (', '.join(TAGGED_AI_TAGS), first))
    conn.executemany('INSERT INTO photo_tags (photo_path, tag) VALUES (?, ?)', [(first, t) for t in TAGGED_AI_TAGS])
    conn.execute("INSERT INTO photo_manual_tags (photo_path, tag, source) VALUES (?, ?, 'user')",
                 (first, TAGGED_OWN_TAG))
    # Object tags: a manual tag written by an installed add-on (created_by = its id, see api/routers/gallery.py).
    conn.execute("INSERT INTO photo_manual_tags (photo_path, tag, source, created_by) VALUES (?, ?, 'user', ?)",
                 (first, TAGGED_OBJECT_TAG, ADDON_ID))
    # People tags: a face assigned to a named person.
    _add_person(conn, first, TAGGED_PERSON, 0)


def _write_addon():
    """An installed external add-on (its UI is the tiny page serve() hosts one port up), so the
    gallery knows whose object tag 'cup' is and the add-on panel can be opened."""
    folder = os.path.join(WORK, 'addons', ADDON_ID)
    os.makedirs(folder)
    with open(os.path.join(folder, 'addon.json'), 'w', encoding='utf-8') as fh:
        json.dump({'id': ADDON_ID, 'name': 'E2E Add-on', 'version': '1.0', 'icon': 'extension', 'facet_api': 1,
                   'slots': ['sidebar'], 'permissions': ['photos.read'],
                   'ui': {'url': f'http://127.0.0.1:{ADDON_UI_PORT}/'}}, fh, indent=2)


def seed(edition_password):
    from db.schema import init_database
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(LIBRARY)
    with open(CONFIG_PATH, 'w', encoding='utf-8') as fh:
        json.dump({'viewer': {'edition_password': edition_password, 'scan_directories': [LIBRARY],
                              'cull': {'allow_trash': True},
                              'features': {'show_scan_button': True}},
                   'addons': {'enabled': True}}, fh, indent=2)
    init_database(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    for folder in PHOTOS:
        _seed_folder(conn, folder)
    for folder in ALBUMS:
        _seed_album(conn, folder)
    _seed_tagged(conn)
    _seed_layout(conn)
    _write_addon()
    conn.commit()
    conn.close()


def reset(folder):
    """Put one folder back as seed() wrote it: its files, its rows and its AI edit links."""
    conn = sqlite3.connect(DB_PATH)
    prefix = os.path.join(LIBRARY, folder, '')
    conn.execute('DELETE FROM photos WHERE substr(path, 1, ?) = ?', (len(prefix), prefix))
    conn.execute('DELETE FROM photo_ai_edits WHERE substr(edit_path, 1, ?) = ?', (len(prefix), prefix))
    shutil.rmtree(prefix, ignore_errors=True)
    _seed_folder(conn, folder)
    conn.commit()
    conn.close()


def reimport(edit_path, colour):
    """Delete an edit and bring a new one in under the same name, as import + scan would.

    The new row is written the way the scanner writes it (no preview_revision), and then the
    post-scan step runs, so the flow exercises the real apply_ai_edit_captions."""
    from db.ai_edits import apply_ai_edit_captions
    conn = sqlite3.connect(DB_PATH)
    source, revision = conn.execute('SELECT source_path, revision FROM photo_ai_edits WHERE edit_path = ?',
                                    (edit_path,)).fetchone()
    group, aggregate, lead = conn.execute('SELECT burst_group_id, aggregate, is_burst_lead FROM photos WHERE path = ?',
                                          (edit_path,)).fetchone()
    conn.execute('DELETE FROM photos WHERE path = ?', (edit_path,))   # the trigger drops the link row
    folder = os.path.basename(os.path.dirname(edit_path))
    # Same score and lead as before: only the picture changes, as with a real second edit.
    _insert_photo(conn, folder, os.path.basename(edit_path), colour, aggregate, lead, group, 30)
    conn.execute('INSERT INTO photo_ai_edits (edit_path, source_path, tool, note, revision) '
                 "VALUES (?, ?, 'antigravity-gemini', 'e2e edit, again', ?)", (edit_path, source, revision))
    apply_ai_edit_captions(conn)
    conn.commit()
    conn.close()


def _serve_addon_page():
    """The add-on's UI: one page with a text field, so a flow can put focus inside the add-on frame."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    page = (b'<!doctype html><meta charset="utf-8"><title>E2E add-on</title>'
            b'<h1>E2E add-on</h1><label>Note <input aria-label="add-on note"></label>')

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(page)))
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', ADDON_UI_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def serve(port, edition_password):
    seed(edition_password)
    _serve_addon_page()
    env = {**os.environ, 'FACET_CONFIG': CONFIG_PATH, 'DB_PATH': DB_PATH, 'PYTHONIOENCODING': 'utf-8',
           'FACET_BUILD': 'e2e', 'XDG_DATA_HOME': XDG_DATA_HOME}
    sys.exit(subprocess.call([sys.executable, 'viewer.py', '--production', '--port', str(port),
                              '--host', '127.0.0.1'], cwd=REPO, env=env))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    sd = sub.add_parser('seed')
    sd.add_argument('--edition-password', required=True)
    s = sub.add_parser('serve')
    s.add_argument('--port', type=int, default=5099)
    s.add_argument('--edition-password', required=True)
    rs = sub.add_parser('reset')
    rs.add_argument('folder', choices=list(PHOTOS))
    r = sub.add_parser('reimport')
    r.add_argument('edit_path')
    r.add_argument('colour')
    args = parser.parse_args()
    os.chdir(REPO)
    if args.cmd == 'seed':
        seed(args.edition_password)
    elif args.cmd == 'serve':
        serve(args.port, args.edition_password)
    elif args.cmd == 'reset':
        reset(args.folder)
    else:
        reimport(args.edit_path, args.colour)
