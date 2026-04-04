-- init-databases.sql
-- Creates separate databases for GitSwarm and Gitea on a shared PostgreSQL instance.
-- Runs once during initial container setup via docker-entrypoint-initdb.d.

-- GitSwarm database
CREATE USER gitswarm WITH PASSWORD 'gitswarm_password';
CREATE DATABASE gitswarm OWNER gitswarm;

-- Gitea database
CREATE USER gitea WITH PASSWORD 'gitea_password';
CREATE DATABASE gitea OWNER gitea;

-- Enable extensions for GitSwarm
\c gitswarm
CREATE EXTENSION IF NOT EXISTS pgvector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
