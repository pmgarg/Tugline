#!/usr/bin/env python3
"""A tiny GTK3 calculator: the AT-SPI test target for the Linux sidecar (SPEC F9 AC1)
and a sample app in the desktop sandbox image (F10). Deterministic, no network."""
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

KEYS = [["AC", "÷"], ["7", "8", "9", "×"], ["4", "5", "6", "−"], ["1", "2", "3", "+"], ["0", "="]]


class Calc:
    def __init__(self):
        self.acc = None
        self.op = None
        self.fresh = True
        self.win = Gtk.Window(title="OH Calc")
        self.win.set_default_size(260, 320)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.display = Gtk.Label(label="0")
        box.pack_start(self.display, False, False, 4)
        for row in KEYS:
            hb = Gtk.Box(spacing=4)
            for k in row:
                b = Gtk.Button(label=k)
                b.connect("clicked", self.press, k)
                hb.pack_start(b, True, True, 0)
            box.pack_start(hb, False, False, 0)
        self.note = Gtk.Entry()
        self.note.get_accessible().set_name("Note")
        box.pack_start(self.note, False, False, 4)
        self.win.add(box)
        self.win.connect("destroy", Gtk.main_quit)
        self.win.show_all()

    def compute(self, a, op, b):
        return a + b if op == "+" else a - b if op == "−" else a * b if op == "×" else a / b if op == "÷" else b

    def press(self, _b, k):
        d = self.display.get_text()
        if k.isdigit():
            self.display.set_text(k if self.fresh or d == "0" else d + k)
            self.fresh = False
        elif k in "+−×÷":
            if self.acc is not None and self.op and not self.fresh:
                self.display.set_text("%g" % self.compute(self.acc, self.op, float(d)))
            self.acc = float(self.display.get_text())
            self.op = k
            self.fresh = True
        elif k == "=":
            if self.op:
                self.display.set_text("%g" % self.compute(self.acc, self.op, float(d)))
            self.acc, self.op, self.fresh = None, None, True
        elif k == "AC":
            self.display.set_text("0")
            self.acc, self.op, self.fresh = None, None, True


if __name__ == "__main__":
    Calc()
    Gtk.main()
