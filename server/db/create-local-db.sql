-- One-time local setup. Run as the postgres superuser:
--   psql -U postgres -f server/db/create-local-db.sql
-- Creates the app user and two databases: one for running the app, one for tests
-- (the test database is wiped by the tests, never point tests at real data).
CREATE ROLE trustvault LOGIN PASSWORD 'trustvault_local' CREATEDB;
CREATE DATABASE trustvault_dev OWNER trustvault;
CREATE DATABASE trustvault_test OWNER trustvault;
