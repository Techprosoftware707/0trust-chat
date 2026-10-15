"""Make core_auditevent append-only at the database level.

UPDATE is always rejected. DELETE is rejected unless the transaction has set
``lumen.audit_purge = 'on'`` (only the retention job does this, for rows older
than the configured retention).
"""

from django.db import migrations

FORWARD = r"""
CREATE OR REPLACE FUNCTION lumen_audit_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit events are append-only';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('lumen.audit_purge', true), '') <> 'on' THEN
    RAISE EXCEPTION 'audit events can only be removed by the retention job';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lumen_audit_guard ON core_auditevent;
CREATE TRIGGER lumen_audit_guard BEFORE UPDATE OR DELETE ON core_auditevent
FOR EACH ROW EXECUTE FUNCTION lumen_audit_guard();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS lumen_audit_guard ON core_auditevent;
DROP FUNCTION IF EXISTS lumen_audit_guard();
"""


def forward(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute(FORWARD)


def reverse(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute(REVERSE)


class Migration(migrations.Migration):
    dependencies = [("core", "0001_initial")]
    operations = [migrations.RunPython(forward, reverse)]
