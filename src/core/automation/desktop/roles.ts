/**
 * Native accessibility roles → ARIA role names (research CU §5.3.1): macOS AX
 * (`AXButton`), Windows UIA (`Button`, `ControlType.Button`) and Linux AT-SPI
 * (`push button`) all become `button`, so web and desktop snapshots read the
 * same to the model and the shared renderer, keys and Expect work unchanged.
 *
 * One deliberate difference: static text elements (AXStaticText, AT-SPI label)
 * become `statictext`, not the browser's inline `text`. The shared renderer
 * drops a `text` run that repeats a sibling control's name (an HTML <label>),
 * which on a desktop would hide a calculator display reading "7" next to the
 * "7" button.
 */

const MAP: Record<string, string> = {
  // buttons
  button: 'button', pushbutton: 'button', 'push button': 'button', togglebutton: 'button', 'toggle button': 'button', splitbutton: 'button', menubutton: 'button', popupbutton: 'combobox',
  // text input
  textfield: 'textbox', textarea: 'textbox', securetextfield: 'textbox', edit: 'textbox', document: 'document', entry: 'textbox', text: 'statictext', 'password text': 'textbox', passwordtext: 'textbox', 'editable text': 'textbox', searchfield: 'searchbox',
  combobox: 'combobox', 'combo box': 'combobox',
  // static text
  statictext: 'statictext', label: 'statictext', 'static text': 'statictext', caption: 'statictext', paragraph: 'statictext', heading: 'heading',
  // choices
  checkbox: 'checkbox', 'check box': 'checkbox', radiobutton: 'radio', 'radio button': 'radio', switch: 'switch',
  slider: 'slider', spinbutton: 'spinbutton', 'spin button': 'spinbutton', stepper: 'spinbutton', incrementor: 'spinbutton', progressindicator: 'progressbar', progressbar: 'progressbar', 'progress bar': 'progressbar', levelindicator: 'meter',
  // menus
  menubar: 'menubar', 'menu bar': 'menubar', menubaritem: 'menuitem', menu: 'menu', menuitem: 'menuitem', 'menu item': 'menuitem', 'check menu item': 'menuitemcheckbox', 'radio menu item': 'menuitemradio', 'popup menu': 'menu',
  // lists, tables, trees
  list: 'list', listitem: 'listitem', 'list item': 'listitem', listbox: 'listbox', 'list box': 'listbox', option: 'option',
  table: 'table', 'table cell': 'cell', cell: 'cell', row: 'row', 'table row': 'row', column: 'column', 'column header': 'columnheader', columnheader: 'columnheader', 'table column header': 'columnheader', header: 'columnheader', headeritem: 'columnheader', datagrid: 'grid', dataitem: 'row', grid: 'grid',
  outline: 'tree', tree: 'tree', 'tree table': 'treegrid', treeitem: 'treeitem', 'tree item': 'treeitem', outlinerow: 'treeitem',
  // tabs
  tabgroup: 'tablist', tab: 'tab', 'page tab': 'tab', 'page tab list': 'tablist', tablist: 'tablist', tabitem: 'tab',
  // structure
  window: 'window', frame: 'window', dialog: 'dialog', sheet: 'dialog', alert: 'alertdialog', 'alert dialog': 'alertdialog', 'file chooser': 'dialog', 'color chooser': 'dialog',
  group: 'group', pane: 'group', panel: 'group', filler: 'generic', splitgroup: 'group', 'split pane': 'group', scrollarea: 'group', 'scroll pane': 'group', layoutarea: 'group', layoutitem: 'group', 'internal frame': 'group', 'layered pane': 'group', 'root pane': 'generic', viewport: 'generic', custom: 'generic', unknown: 'generic', section: 'generic', form: 'form',
  toolbar: 'toolbar', 'tool bar': 'toolbar', statusbar: 'status', 'status bar': 'status', titlebar: 'banner', 'title bar': 'banner',
  scrollbar: 'scrollbar', 'scroll bar': 'scrollbar', separator: 'separator', splitter: 'separator',
  image: 'img', icon: 'img', 'desktop icon': 'img', canvas: 'canvas', 'drawing area': 'canvas',
  link: 'link', hyperlink: 'link',
  webarea: 'document', 'document web': 'document', 'document frame': 'document', application: 'application',
  application_: 'application',
  colorwell: 'button', disclosuretriangle: 'button', 'tear off menu item': 'menuitem', 'push button menu': 'button',
};

/** Normalise one native role string to an ARIA role name. Unknown roles pass through lower-cased. */
export function ariaRole(native: string | undefined): string {
  if (!native) return 'generic';
  let r = native.trim();
  r = r.replace(/^ControlType\./, '').replace(/^AX/, '').replace(/^ROLE_/, '').replace(/_/g, ' ');
  const lower = r.toLowerCase();
  if (MAP[lower]) return MAP[lower];
  const squashed = lower.replace(/\s+/g, '');
  if (MAP[squashed]) return MAP[squashed];
  return squashed || 'generic';
}

/** Roles that mean "an opaque web area" (the Electron trap, S10). */
export function isWebArea(native: string | undefined): boolean {
  return /^(AXWebArea|document web|ROLE_DOCUMENT_WEB|Document)$/i.test(native ?? '') || /webarea/i.test(native ?? '');
}

/** Roles that mean "pixels only" (canvas, games, remote desktop surfaces). */
export function isCanvasLike(native: string | undefined): boolean {
  return /canvas|drawing area|opengl|AXLayoutArea/i.test(native ?? '');
}

/** Native roles of password fields (values are masked). */
export function isSecureField(native: string | undefined): boolean {
  return /securetextfield|password text|passwordtext/i.test(native ?? '');
}
