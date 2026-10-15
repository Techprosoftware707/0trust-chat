#!/bin/sh
# Creates or reconciles Lumen's database roles and databases.
# Runs automatically on first initialisation (docker-entrypoint-initdb.d) and
# again on every install/update via `docker compose exec postgres`, so that
# rotated passwords from /run/secrets are applied. Idempotent.
set -eu

app_pw="$(cat /run/secrets/postgres_app_password)"
syn_pw="$(cat /run/secrets/synapse_db_password)"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
     -v app_pw="$app_pw" -v syn_pw="$syn_pw" <<'SQL'
SELECT 'CREATE ROLE lumen_app LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lumen_app')\gexec
SELECT 'CREATE ROLE synapse LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synapse')\gexec
ALTER ROLE lumen_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_pw';
ALTER ROLE synapse WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'syn_pw';
SELECT 'CREATE DATABASE lumen OWNER lumen_app ENCODING ''UTF8'' TEMPLATE template0'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'lumen')\gexec
SELECT 'CREATE DATABASE synapse OWNER synapse ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C'' TEMPLATE template0'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'synapse')\gexec
REVOKE CONNECT ON DATABASE lumen FROM PUBLIC;
REVOKE CONNECT ON DATABASE synapse FROM PUBLIC;
GRANT CONNECT ON DATABASE lumen TO lumen_app;
GRANT CONNECT ON DATABASE synapse TO synapse;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL

for db in lumen synapse; do
  owner=lumen_app; [ "$db" = synapse ] && owner=synapse
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "$db" \
       -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO $owner; GRANT ALL ON SCHEMA public TO $owner;"
done
echo "lumen: database roles reconciled"
