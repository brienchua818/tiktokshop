"""Generate the redesign artboards from one set of components and two palettes.

Run:  python3 build.py   (then re-seed the canvas)
Tokens come from src/index.css; the light palette is derived to keep the same
roles at the same contrast (≥ 4.5:1 for text, ≥ 3:1 for UI) on a warm off-white.
"""
import pathlib

DARK = dict(
    name='dark', ink='#0f0f0f', surface='#161616', raised='#1a1a1a', sunken='#111111',
    line='rgba(255,255,255,0.10)', line2='rgba(255,255,255,0.08)', hair='rgba(255,255,255,0.05)',
    text='#ffffff', text2='#d1d5db', muted='#9ca3af', faint='#6b7280', ghost='#4b5563',
    accent='#ec4899', ident='#fbbf24', live='#34d399', livebg='rgba(16,185,129,0.12)',
    warn='#fbbf24', blue='#93c5fd', bluedot='#60a5fa', bluebg='rgba(59,130,246,0.15)',
    voice='rgba(147,51,234,0.8)', export='#10b981', exporttext='#052e16', thumb='linear-gradient(135deg, #2a2a2a, #3a3a3a)',
    handle='#374151', dashed='rgba(255,255,255,0.14)', scrim='rgba(0,0,0,0.6)', tabon='#ec4899', taboff='#6b7280',
)
LIGHT = dict(
    name='light', ink='#f4f4f2', surface='#ffffff', raised='#ffffff', sunken='#f0f0ee',
    line='rgba(0,0,0,0.12)', line2='rgba(0,0,0,0.08)', hair='rgba(0,0,0,0.06)',
    text='#111111', text2='#1f2937', muted='#4b5563', faint='#6b7280', ghost='#9ca3af',
    accent='#db2777', ident='#b45309', live='#047857', livebg='rgba(5,150,105,0.12)',
    warn='#b45309', blue='#1d4ed8', bluedot='#2563eb', bluebg='rgba(37,99,235,0.10)',
    voice='#7e22ce', export='#059669', exporttext='#ffffff', thumb='linear-gradient(135deg, #e5e5e3, #d4d4d2)',
    handle='#d1d5db', dashed='rgba(0,0,0,0.18)', scrim='rgba(17,17,17,0.45)', tabon='#db2777', taboff='#6b7280',
)

def icon(name, size=20, color='#fff', sw=1.8):
    P = {
      'camera': '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/>',
      'mic': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
      'image': '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20 16l-5-5-7 8"/>',
      'sparkle': '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
      'refresh': '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
      'chev': '<path d="M6 9l6 6 6-6"/>',
      'chevr': '<path d="M9 6l6 6-6 6"/>',
      'list': '<path d="M4 7h16M4 12h16M4 17h16"/>',
      'receipt': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
      'dots': '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
      'cal': '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
      'sync': '<path d="M4 12a8 8 0 0 1 13.7-5.7M20 12a8 8 0 0 1-13.7 5.7"/><path d="M18 3v4h-4M6 21v-4h4"/>',
      'download': '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
      'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      'moon': '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
      'auto': '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
      'users': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5a5 5 0 0 1 6 5"/>',
      'out': '<path d="M10 4H5v16h5M14 8l5 4-5 4M19 12H9"/>',
      'sheet': '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
      'info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    }[name]
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="{sw}" '
            f'stroke-linecap="round" stroke-linejoin="round" style="display: block; flex-shrink: 0; color: {color};">{P}</svg>')

def doc(t, body):
    return f'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
body {{ margin: 0; background: {t['ink']}; color: {t['text']}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 14px; -webkit-font-smoothing: antialiased; }}
a {{ color: {t['accent']}; }} a:hover {{ color: {t['accent']}; }}
.mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }}
  </style>
</helmet>
{body}
</x-dc>
</body>
</html>
'''

def topstrip(t, waiting='1 waiting'):
    return f'''
<div style="display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; background: {t['surface']}; border-bottom: 1px solid {t['line']}; flex-shrink: 0;">
  <div style="display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px 0 12px; border-radius: 8px; background: {t['raised']}; border: 1px solid {t['line']};">
    <span style="font-size: 14px; font-weight: 600; color: {t['text']};">HOUZE</span>{icon('chev', 16, t['muted'])}
  </div>
  <div style="flex-grow: 1;"></div>
  <div style="display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px; background: {t['bluebg']};">
    <span style="width: 6px; height: 6px; border-radius: 3px; background: {t['bluedot']}; display: block;"></span>
    <span style="font-size: 12px; color: {t['blue']};">{waiting}</span>
  </div>
</div>'''

def tabbar(t, active='listing'):
    def tab(key, label, ic):
        on = key == active
        col = t['tabon'] if on else t['taboff']
        return (f'<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; flex-grow: 1; height: 56px;">'
                f'{icon(ic, 22, col)}<span style="font-size: 11px; color: {col}; font-weight: {600 if on else 500};">{label}</span></div>')
    return f'''
<div style="display: flex; align-items: stretch; height: 56px; background: {t['surface']}; border-top: 1px solid {t['line']}; flex-shrink: 0;">
  {tab('listing','Listing','list')}{tab('orders','Orders','receipt')}{tab('more','More','dots')}
</div>'''

def pill(t, label):
    return f'<span style="display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; background: {t["livebg"]}; color: {t["live"]}; font-size: 12px; font-weight: 600;">{label}</span>'

def listingbar(t):
    return f'''
<div style="display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; flex-shrink: 0;">
  <span style="font-size: 14px; font-weight: 600; color: {t['text']}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex-grow: 1;">HOUZE x Table Matters - I12 Clearance Sale</span>
  <span style="font-size: 12px; color: {t['muted']}; white-space: nowrap;">10/100</span>
  {pill(t, 'Live')}
  {icon('chev', 18, t['muted'])}
</div>'''

def bigbtn(t, ic, label, kind):
    if kind == 'primary':   bg, bd, col = t['accent'], t['accent'], '#ffffff'
    elif kind == 'voice':   bg, bd, col = t['voice'], t['voice'], '#ffffff'
    else:                   bg, bd, col = t['sunken'], t['line'], t['text2']
    return (f'<div style="display: flex; align-items: center; justify-content: center; gap: 8px; height: 52px; border-radius: 10px; background: {bg}; border: 1px solid {bd};">'
            f'{icon(ic, 22, col)}<span style="font-size: 14px; font-weight: 600; color: {col};">{label}</span></div>')

def field(t, placeholder, value=None, prefix=None):
    text = (f'<span style="font-size: 16px; color: {t["text"]};">{value}</span>' if value
            else f'<span style="font-size: 16px; color: {t["ghost"]};">{placeholder}</span>')
    pre = f'<span style="font-size: 16px; color: {t["faint"]};">{prefix}</span>' if prefix else ''
    return (f'<div style="display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 12px; border-radius: 8px; background: {t["sunken"]}; '
            f'border: 1px solid {t["line"]}; width: 100%; box-sizing: border-box;">{pre}{text}</div>')

def skuform(t, photo_px=112):
    return f'''
<div style="display: flex; flex-direction: column; gap: 10px; padding: 12px; margin: 0 12px; border-radius: 12px; background: {t['raised']}; border: 1px solid {t['line2']};">
  <div style="display: flex; align-items: baseline; gap: 8px;">
    <span class="mono" style="font-size: 22px; font-weight: 600; color: {t['ident']}; letter-spacing: 0.04em;">B10</span>
    <span style="font-size: 12px; color: {t['faint']};">next SKU · prefix B</span>
    <div style="flex-grow: 1;"></div>
    <span style="font-size: 12px; color: {t['muted']}; text-decoration: underline; text-underline-offset: 3px;">Bulk add</span>
  </div>
  <div style="display: flex; gap: 10px;">
    <div style="display: flex; align-items: center; justify-content: center; width: {photo_px}px; height: {photo_px}px; border-radius: 10px; background: {t['sunken']}; border: 1px dashed {t['dashed']}; flex-shrink: 0;">{icon('image', 28, t['ghost'], 1.5)}</div>
    <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; flex-grow: 1; min-width: 0;">
      {bigbtn(t,'camera','Camera','primary')}
      {bigbtn(t,'mic','Voice','voice')}
      {bigbtn(t,'image','Photos','plain')}
      {bigbtn(t,'sparkle','AI name','plain')}
    </div>
  </div>
  <div style="display: flex; flex-direction: column; gap: 4px;">
    {field(t, 'Variant name — say it, or type it')}
    <span class="mono" style="font-size: 12px; color: {t['faint']}; padding-left: 2px;">B10 · name it above</span>
  </div>
  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
    {field(t, 'Price', prefix='$')}
    {field(t, 'Stock')}
  </div>
</div>'''

# One row per variation, with WHERE IT CAME FROM, because the shipped queue is
# now the union of this phone's drafts and everything the backend and TikTok
# know about the listing. Source decides the thumbnail and the caption:
#   mine   — this phone made it, photo from this device
#   other  — listed from another phone, TikTok's own picture, named lister
#   sc     — added in Seller Center, no identifier of ours
ROWS = [
  ('B9','Off White Wireless Mouse','$999','1 of 1','Live','mine'),
  ('L11','Chrome 3 Tier Kitchen Trolley','$83','0 of 1 · 1 sold','Live','other'),
  ('B8','Black Laptop with Numeric Keypad','$8888','1 of 1','Live','mine'),
  ('L12','Ceramic Cat Treat Jar','$65','1 of 1','Reviewing','other'),
  ('','Diatomite Absorbent Mat','$88','1 in stock','Live','sc'),
  ('B7','Double Wall Rounded Glass Tumbler','$999','1 of 1','Live','mine'),
  ('B6','Silver Magnetic Charging Stand','$9999','1 of 1','Live','mine'),
  ('A1','Orange Label Clear Glass Bottle','$9.90','1 of 1','Live','mine'),
]

def thumb(t, source):
    if source == 'sc':
        return (f'<div style="display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 6px; '
                f'background: {t["sunken"]}; border: 1px solid {t["line2"]}; flex-shrink: 0;">'
                f'<span style="font-size: 10px; font-weight: 600; color: {t["ghost"]};">SC</span></div>')
    return f'<div style="width: 40px; height: 40px; border-radius: 6px; background: {t["thumb"]}; flex-shrink: 0;"></div>'

def skurow(t, idf, name, price, stock, status, source):
    colour = {'Live': t['live'], 'Reviewing': t['warn'], 'Retrying': t['warn'], 'Removed': t['faint']}[status]
    st = f'<span style="font-size: 12px; font-weight: 600; color: {colour};">{status}</span>'
    if status == 'Retrying':
        text, col = 'No reply after 120s · may already be listed', t['warn']
    elif status == 'Reviewing':
        text, col = 'listed by Judy · under review', t['faint']
    elif source == 'other':
        text, col = f'listed by Judy · {stock} · {price}', t['faint']
    elif source == 'sc':
        text, col = f'added outside this app · {stock}', t['faint']
    else:
        text, col = f'{stock} · {price}', t['faint']
    # One line, always: the row is a fixed 56 px and a wrapped caption shunts
    # every SKU below it down the screen.
    sub = (f'<span style="font-size: 12px; color: {col}; white-space: nowrap; overflow: hidden; '
           f'text-overflow: ellipsis;">{text}</span>')
    label = (f'<span class="mono" style="font-size: 13px; font-weight: 600; color: {t["ident"]}; flex-shrink: 0;">{idf}</span>'
             if idf else f'<span class="mono" style="font-size: 13px; color: {t["ghost"]}; flex-shrink: 0;">—</span>')
    return f'''<div style="display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 12px; border-bottom: 1px solid {t['hair']};">
  {thumb(t, source)}
  <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0; flex-grow: 1;">
    <div style="display: flex; align-items: baseline; gap: 8px; min-width: 0;">
      {label}
      <span style="font-size: 13px; color: {t['text2']}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{name}</span>
    </div>
    {sub}
  </div>
  {st}
</div>'''

def queue(t, n_rows, margin='0 12px', stale=False):
    """The SKU list. `stale` shows what a check that timed out looks like."""
    rows = skurow(t, 'B10','Off White Wireless Mouse','$999','1 of 1','Retrying','mine') + ''.join(
        skurow(t, *r) for r in ROWS[:n_rows])
    label = 'ON LISTING' if stale else 'ON THIS LISTING'
    if stale:
        head = (f'<span style="font-size: 12px; color: {t["warn"]}; white-space: nowrap;">no reply · showing 12:41</span>')
        button = (f'<div style="display: flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 10px; '
                  f'border-radius: 8px; border: 1px solid {t["warn"]};">{icon("refresh", 16, t["warn"])}'
                  f'<span style="font-size: 12px; font-weight: 600; color: {t["warn"]};">Retry</span></div>')
    else:
        head = f'<span style="font-size: 12px; color: {t["faint"]}; white-space: nowrap;">3 phones · checked 12:56</span>'
        button = f'<div style="display: flex; align-items: center; justify-content: center; width: 44px; height: 40px; border-radius: 8px;">{icon("refresh", 20, t["text2"])}</div>'
    return f'''
<div style="display: flex; flex-direction: column; margin: {margin}; border-radius: 12px; background: {t['raised']}; border: 1px solid {t['line2']}; overflow: hidden; flex-grow: 1; min-height: 0;">
  <div style="display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 4px 0 12px; border-bottom: 1px solid {t['line2']}; flex-shrink: 0;">
    <span style="font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: {t['muted']}; white-space: nowrap;">{label}</span>
    <span style="font-size: 12px; color: {t['faint']};">12</span>
    <div style="flex-grow: 1;"></div>
    {head}
    {button}
  </div>
  <div style="display: flex; flex-direction: column; overflow: hidden; flex-grow: 1; min-height: 0;">
    {rows}
  </div>
</div>'''

def savebar(t, label='List B10'):
    return f'''
<div style="display: flex; align-items: center; height: 56px; padding: 6px 12px; background: {t['surface']}; border-top: 1px solid {t['line2']}; flex-shrink: 0;">
  <div style="display: flex; align-items: center; justify-content: center; height: 44px; border-radius: 10px; background: {t['accent']}; flex-grow: 1;">
    <span style="font-size: 15px; font-weight: 600; color: #fff;">{label}</span>
  </div>
</div>'''

def phone(t, *parts):
    return doc(t, f'<div style="display: flex; flex-direction: column; width: 390px; height: 844px; background: {t["ink"]}; overflow: hidden;">' + ''.join(parts) + '</div>')

SP8 = '<div style="height: 8px; flex-shrink: 0;"></div>'

def listing_phone(t, stale=False):
    return phone(t, topstrip(t), listingbar(t), skuform(t), SP8, queue(t, 5, stale=stale), SP8, savebar(t), tabbar(t, 'listing'))

LISTINGS = [
  ('HOUZE x Table Matters - I12 Clearance Sale','43 orders','50 units','$2,114.75'),
  ('[ANY 4 FOR $38.88] Table Matters - Assorted 9 inch Ramen Bowl','1 order','2 units','$29.38'),
  ('[ANY 10 FOR $18] Table Matters - Assorted Flower Shaped & Lotus Leaf Saucer','1 order','2 units','$6.23'),
  ('[ANY 6 FOR $38.88] Table Matters - Assorted 7-inch Ramen Bowl','1 order','1 unit','$9.79'),
  ('HOUZE - MegaPop 2 | 3 | 4 Tier Display Cabinet With Wheels','1 order','1 unit','$155.90'),
  ('HOUZE - KRUSTY Slim 45L Laundry Basket with Flipping Lid','1 order','1 unit','$27.30'),
  ('HOUZE - FLERO Collapsible Storage Box With Wheels','1 order','1 unit','$60.90'),
]
def listingrow(t, name, orders, units, rev):
    return f'''<div style="display: flex; align-items: center; gap: 10px; height: 60px; padding: 0 12px; border-bottom: 1px solid {t['hair']};">
  <div style="display: flex; flex-direction: column; gap: 3px; min-width: 0; flex-grow: 1;">
    <span style="font-size: 13px; color: {t['text2']}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{name}</span>
    <span style="font-size: 12px; color: {t['faint']};">{orders} · {units}</span>
  </div>
  <span class="mono" style="font-size: 13px; color: {t['text2']}; flex-shrink: 0;">{rev}</span>
  {icon('chevr', 16, t['ghost'])}
</div>'''

def rangebar(t):
    return f'''
<div style="display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; flex-shrink: 0;">
  <div style="display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 8px; background: {t['raised']}; border: 1px solid {t['line']}; min-width: 0; flex-grow: 1;">
    {icon('cal', 16, t['muted'])}<span style="font-size: 13px; color: {t['text']}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">4 Sep 00:00 → 7 Sep 23:59</span>{icon('chev', 14, t['faint'])}
  </div>
  <div style="display: flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 8px; background: {t['accent']};">
    {icon('sync', 16, '#fff')}<span style="font-size: 13px; font-weight: 600; color: #fff;">Sync</span>
  </div>
</div>'''

def statsline(t):
    return f'''
<div style="display: flex; align-items: baseline; gap: 10px; height: 36px; padding: 0 12px; flex-shrink: 0;">
  <span style="font-size: 13px; color: {t['text2']};"><span style="color: {t['text']}; font-weight: 600;">50</span> orders</span>
  <span style="font-size: 13px; color: {t['text2']};"><span style="color: {t['text']}; font-weight: 600;">59</span> items</span>
  <span class="mono" style="font-size: 13px; color: {t['text']}; font-weight: 600;">$2,394.05</span>
  <div style="flex-grow: 1;"></div>
  <span style="font-size: 12px; color: {t['faint']};">synced 01:06</span>
</div>'''

def listingscard(t, n, hint=True):
    h = f'<span style="font-size: 12px; color: {t["faint"]}; margin-left: 8px;">tap one for its variations</span>' if hint else ''
    return f'''
<div style="display: flex; flex-direction: column; margin: 0 12px; border-radius: 12px; background: {t['raised']}; border: 1px solid {t['line2']}; overflow: hidden; flex-grow: 1; min-height: 0;">
  <div style="display: flex; align-items: center; height: 40px; padding: 0 12px; border-bottom: 1px solid {t['line2']}; flex-shrink: 0;">
    <span style="font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: {t['muted']};">LISTINGS</span>{h}
  </div>
  <div style="display: flex; flex-direction: column; overflow: hidden;">{''.join(listingrow(t, *l) for l in LISTINGS[:n])}</div>
</div>'''

def exportbar(t):
    return f'''
<div style="display: flex; align-items: center; gap: 8px; height: 56px; padding: 6px 12px; background: {t['surface']}; border-top: 1px solid {t['line2']}; flex-shrink: 0;">
  <div style="display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 12px; border-radius: 10px; background: {t['sunken']}; border: 1px solid {t['line']}; width: 110px; box-sizing: border-box;">
    <span style="font-size: 13px; color: {t['faint']};">cost ÷</span><span style="font-size: 16px; color: {t['text']};">1.6</span>
  </div>
  <div style="display: flex; align-items: center; justify-content: center; gap: 8px; height: 44px; border-radius: 10px; background: {t['export']}; flex-grow: 1;">
    {icon('download', 18, t['exporttext'])}<span style="font-size: 15px; font-weight: 600; color: {t['exporttext']};">Export purchase order</span>
  </div>
</div>'''

def orders_phone(t):
    return phone(t, topstrip(t), rangebar(t), statsline(t), listingscard(t, 7), SP8, exportbar(t), tabbar(t, 'orders'))

def chip(t, label, on=False):
    return (f'<div style="display: inline-flex; align-items: center; height: 36px; padding: 0 12px; border-radius: 8px; background: {t["accent"] if on else t["sunken"]}; '
            f'border: 1px solid {t["accent"] if on else t["line"]};"><span style="font-size: 13px; color: {"#fff" if on else t["text2"]};">{label}</span></div>')

def orders_sheet(t):
    body = f'''
<div style="position: relative; display: flex; flex-direction: column; width: 390px; height: 844px; background: {t['ink']}; overflow: hidden;">
  {topstrip(t)}{rangebar(t)}{statsline(t)}{listingscard(t, 3, hint=False)}
  <div style="position: absolute; left: 0; top: 0; width: 390px; height: 844px; background: {t['scrim']};"></div>
  <div style="position: absolute; left: 0; bottom: 0; width: 390px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 20px; border-radius: 16px 16px 0 0; background: {t['surface']}; border-top: 1px solid {t['line']};">
    <div style="width: 36px; height: 4px; border-radius: 2px; background: {t['handle']}; align-self: center;"></div>
    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
      {chip(t,'Last night 6pm–12am')}{chip(t,'Today')}{chip(t,'Yesterday')}{chip(t,'Since 4 Sep', True)}
    </div>
    <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
      <div style="display: flex; flex-direction: column; gap: 6px;"><span style="font-size: 12px; color: {t['muted']};">From</span>{field(t,'', value='4 Sep 2026')}{field(t,'', value='12:00 AM')}</div>
      <div style="display: flex; flex-direction: column; gap: 6px;"><span style="font-size: 12px; color: {t['muted']};">To</span>{field(t,'', value='7 Sep 2026')}{field(t,'', value='11:59 PM')}</div>
    </div>
    <div style="display: flex; align-items: center; justify-content: center; gap: 8px; height: 48px; border-radius: 10px; background: {t['accent']};">
      {icon('sync', 18, '#fff')}<span style="font-size: 15px; font-weight: 600; color: #fff;">Apply and sync from TikTok</span>
    </div>
    <span style="font-size: 12px; color: {t['faint']}; text-align: center;">Re-syncing the same window updates cancellations, never duplicates.</span>
  </div>
</div>'''
    return doc(t, body)

def more_phone(t, mode='dark'):
    def seg(label, ic, on):
        return (f'<div style="display: flex; align-items: center; justify-content: center; gap: 6px; height: 40px; border-radius: 8px; flex-grow: 1; '
                f'background: {t["raised"] if on else "transparent"}; border: 1px solid {t["line"] if on else "transparent"};">'
                f'{icon(ic, 18, t["text"] if on else t["faint"])}<span style="font-size: 13px; font-weight: {600 if on else 500}; color: {t["text"] if on else t["faint"]};">{label}</span></div>')
    def row(ic, label, sub, trailing=''):
        return f'''<div style="display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 12px; border-bottom: 1px solid {t['hair']};">
  {icon(ic, 20, t['muted'])}
  <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0; flex-grow: 1;">
    <span style="font-size: 14px; color: {t['text']};">{label}</span><span style="font-size: 12px; color: {t['faint']}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{sub}</span>
  </div>{trailing or icon('chevr', 16, t['ghost'])}</div>'''
    body = f'''
<div style="display: flex; flex-direction: column; width: 390px; height: 844px; background: {t['ink']}; overflow: hidden;">
  {topstrip(t)}
  <div style="display: flex; flex-direction: column; gap: 12px; padding: 12px;">
    <div style="display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; background: {t['raised']}; border: 1px solid {t['line2']};">
      <span style="font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: {t['muted']};">APPEARANCE</span>
      <div style="display: flex; gap: 4px; padding: 4px; border-radius: 10px; background: {t['sunken']}; border: 1px solid {t['line2']};">
        {seg('Auto','auto', mode=='auto')}{seg('Day','sun', mode=='light')}{seg('Dark','moon', mode=='dark')}
      </div>
      <span style="font-size: 12px; color: {t['faint']};">Auto follows the phone. Day for a bright factory floor, Dark for the evening stream.</span>
    </div>
    <div style="display: flex; flex-direction: column; border-radius: 12px; background: {t['raised']}; border: 1px solid {t['line2']}; overflow: hidden;">
      {row('users','Users','1 pending approval · judy@sheldonglobal.com', f'<span style="font-size: 12px; font-weight: 600; color: {t["warn"]};">1</span>')}
      {row('sheet','Data sheet and exports','Opens the shared drive')}
      {row('refresh','Check TikTok for this listing','Review state, stock, what landed')}
      {row('info','About and error codes','v2026.09.07 · TS-codes explained')}
    </div>
    <div style="display: flex; flex-direction: column; border-radius: 12px; background: {t['raised']}; border: 1px solid {t['line2']}; overflow: hidden;">
      {row('out','Sign out','admin · signed in until 11:38 PM', '<span></span>')}
    </div>
  </div>
  <div style="flex-grow: 1;"></div>
  {tabbar(t, 'more')}
</div>'''
    return doc(t, body)

def tablet(t):
    def tab_inline(label, on):
        return (f'<div style="display: flex; align-items: center; height: 36px; padding: 0 14px; border-radius: 8px; background: {t["accent"] if on else "transparent"};">'
                f'<span style="font-size: 14px; font-weight: 600; color: {"#fff" if on else t["muted"]};">{label}</span></div>')
    body = f'''
<div style="display: flex; flex-direction: column; width: 1194px; height: 834px; background: {t['ink']}; overflow: hidden;">
  <div style="display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 16px; background: {t['surface']}; border-bottom: 1px solid {t['line']}; flex-shrink: 0;">
    <span style="font-size: 15px; font-weight: 700; color: {t['accent']};">TikShop</span>
    <div style="display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px 0 12px; border-radius: 8px; background: {t['raised']}; border: 1px solid {t['line']};"><span style="font-size: 14px; font-weight: 600; color: {t['text']};">HOUZE</span>{icon('chev', 16, t['muted'])}</div>
    <div style="display: flex; align-items: center; gap: 4px; margin-left: 12px;">{tab_inline('Listing', True)}{tab_inline('Orders', False)}</div>
    <div style="flex-grow: 1;"></div>
    <div style="display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px; background: {t['bluebg']};"><span style="width: 6px; height: 6px; border-radius: 3px; background: {t['bluedot']}; display: block;"></span><span style="font-size: 12px; color: {t['blue']};">1 waiting</span></div>
    <div style="display: flex; align-items: center; gap: 6px;">{icon('sun', 16, t['faint'])}<span style="font-size: 12px; color: {t['faint']};">Brien · Sign out</span></div>
  </div>
  <div style="display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: 12px; padding: 12px 16px 16px; flex-grow: 1; min-height: 0;">
    <div style="display: flex; flex-direction: column; gap: 10px; min-width: 0;">
      <div style="display: flex; align-items: center; gap: 10px; height: 40px;">
        <span style="font-size: 15px; font-weight: 600; color: {t['text']}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;">HOUZE x Table Matters - I12 Clearance Sale</span>
        <span style="font-size: 12px; color: {t['muted']}; white-space: nowrap;">10/100 variations</span>
        {pill(t, 'Live')}
        <div style="flex-grow: 1;"></div>
        <span style="font-size: 13px; color: {t['muted']}; text-decoration: underline; text-underline-offset: 3px;">Change listing</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 12px; background: {t['raised']}; border: 1px solid {t['line2']};">
        <div style="display: flex; align-items: baseline; gap: 10px;">
          <span class="mono" style="font-size: 26px; font-weight: 600; color: {t['ident']}; letter-spacing: 0.04em;">B10</span>
          <span style="font-size: 13px; color: {t['faint']};">next SKU · prefix B</span>
          <div style="flex-grow: 1;"></div>
          <span style="font-size: 13px; color: {t['muted']}; text-decoration: underline; text-underline-offset: 3px;">Bulk add</span>
        </div>
        <div style="display: flex; gap: 14px;">
          <div style="display: flex; align-items: center; justify-content: center; width: 200px; height: 200px; border-radius: 12px; background: {t['sunken']}; border: 1px dashed {t['dashed']}; flex-shrink: 0;">{icon('image', 36, t['ghost'], 1.5)}</div>
          <div style="display: flex; flex-direction: column; gap: 10px; flex-grow: 1; min-width: 0;">
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;">
              {bigbtn(t,'camera','Camera','primary')}{bigbtn(t,'mic','Voice','voice')}{bigbtn(t,'image','Photos','plain')}{bigbtn(t,'sparkle','AI name','plain')}
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px;">{field(t,'Variant name — say it, or type it')}<span class="mono" style="font-size: 12px; color: {t['faint']}; padding-left: 2px;">B10 · name it above</span></div>
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;">{field(t,'Price', prefix='$')}{field(t,'Stock')}</div>
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <div style="display: flex; align-items: center; justify-content: center; height: 48px; padding: 0 28px; border-radius: 10px; background: {t['accent']};"><span style="font-size: 15px; font-weight: 600; color: #fff;">List B10</span></div>
        </div>
      </div>
    </div>
    <div style="display: flex; flex-direction: column; min-height: 0;">{queue(t, 8, margin='0')}</div>
  </div>
</div>'''
    return doc(t, body)

def before(img):
    return doc(DARK, f'<div style="display: flex; flex-direction: column; width: 390px; height: 844px; background: #0f0f0f; overflow: hidden;"><img src="{img}" style="display: block; width: 390px; height: 844px; object-fit: cover; object-position: top;"></div>')

out = {
  'Main.dc.html': listing_phone(DARK),
  'OrdersPhone.dc.html': orders_phone(DARK),
  'OrdersRange.dc.html': orders_sheet(DARK),
  'More.dc.html': more_phone(DARK, 'dark'),
  'Timeout.dc.html': listing_phone(DARK, stale=True),
  'MainDay.dc.html': listing_phone(LIGHT),
  'OrdersDay.dc.html': orders_phone(LIGHT),
  'MoreDay.dc.html': more_phone(LIGHT, 'light'),
  'TabletListing.dc.html': tablet(DARK),
  'TabletDay.dc.html': tablet(LIGHT),
  'NowListing.dc.html': before('before-listing.jpg'),
  'NowOrders.dc.html': before('before-orders.jpg'),
}
for k, v in out.items():
    pathlib.Path(k).write_text(v)
print('wrote', len(out), 'artboards')
