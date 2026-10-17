"""Background jobs run by the worker (manage.py lumen_worker):
JOBS = [("name", interval_seconds, callable)]. Jobs must be idempotent and scope every
query to one workspace at a time."""

JOBS: list = []
