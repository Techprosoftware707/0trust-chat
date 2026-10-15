"""
Minimal org.freedesktop.Notifications server for the desktop e2e test (the "OS notification
service" of a Linux desktop). It records every Notify call as a JSON line and can emit
ActionInvoked (a click) on request, so the test sees exactly what the app sent to the OS and
can click a notification the way a desktop shell does.

    python3 notification_server.py <records.jsonl>      (DBUS_SESSION_BUS_ADDRESS must be set)
    gdbus call --session --dest org.freedesktop.Notifications \
      --object-path /org/freedesktop/Notifications --method org.lumen.Test.Invoke <id> default
"""
import json
import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

IFACE = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"


class Server(dbus.service.Object):
    def __init__(self, bus, out):
        super().__init__(bus, PATH)
        self.out = out
        self.next_id = 0

    @dbus.service.method(IFACE, in_signature="", out_signature="as")
    def GetCapabilities(self):
        return ["body", "actions", "persistence"]

    @dbus.service.method(IFACE, in_signature="", out_signature="ssss")
    def GetServerInformation(self):
        return ("lumen-e2e-notifications", "lumen", "1.0", "1.2")

    @dbus.service.method(IFACE, in_signature="susssasa{sv}i", out_signature="u")
    def Notify(self, app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout):
        self.next_id += 1
        rec = {
            "id": self.next_id,
            "app_name": str(app_name),
            "summary": str(summary),
            "body": str(body),
            "actions": [str(a) for a in actions],
            "icon": str(app_icon),
        }
        with open(self.out, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        return dbus.UInt32(self.next_id)

    @dbus.service.method(IFACE, in_signature="u", out_signature="")
    def CloseNotification(self, nid):
        self.NotificationClosed(nid, 3)

    @dbus.service.signal(IFACE, signature="us")
    def ActionInvoked(self, nid, action_key):
        pass

    @dbus.service.signal(IFACE, signature="uu")
    def NotificationClosed(self, nid, reason):
        pass

    @dbus.service.method("org.lumen.Test", in_signature="us", out_signature="")
    def Invoke(self, nid, action_key):
        self.ActionInvoked(nid, action_key)


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    name = dbus.service.BusName(IFACE, bus, do_not_queue=True)
    Server(bus, sys.argv[1])
    print("ready", flush=True)
    GLib.MainLoop().run()
    del name


if __name__ == "__main__":
    main()
