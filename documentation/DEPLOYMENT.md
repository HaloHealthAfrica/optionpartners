# TradeTally Docker Deployment Guide

Deploy TradeTally quickly using Docker and Docker Compose.

## Quick Start

### Prerequisites
- Docker Engine 20.10+
- Docker Compose 2.0+

### 1. Download Deployment Files

Create a new directory and download the required files:

```bash
mkdir tradetally
cd tradetally

# Download the docker-compose file
curl -O https://raw.githubusercontent.com/GeneBO98/tradetally/refs/heads/main/docker-compose.yaml

# Download the environment template
curl -O https://raw.githubusercontent.com/GeneBO98/tradetally/main/.env.example

# Rename to .env
mv .env.example .env
```

### 2. Configure Environment

Edit the `.env` file with your settings:

```bash
nano .env  # or vim .env
```

**Required configurations:**
- `DB_USER`: Database username (default: trader)
- `DB_PASSWORD`: Set a strong database password
- `DB_NAME`: Database name (default: tradetally)
- `JWT_SECRET`: Change this to a secure random string
- `CORS_ORIGINS`: Additional CORS origins for mobile apps

**Important optional configurations:**
- `NODE_ENV`: Environment mode (default: production)
- `PORT`: Backend port (default: 3000)
- `FRONTEND_URL`: Frontend URL for CORS (default: http://localhost:5173)
- `VITE_API_URL`: Frontend API URL (default: http://localhost/api)
- `REGISTRATION_MODE`: Controls user registration (default: open)

**Email configuration (optional but recommended):**
- `EMAIL_HOST`: SMTP server host
- `EMAIL_PORT`: SMTP server port
- `EMAIL_USER`: SMTP username
- `EMAIL_PASS`: SMTP password
- `EMAIL_FROM`: From email address

**External API keys (optional but recommended for full functionality):**
- `FINNHUB_API_KEY`: For real-time quotes and CUSIP resolution
- `ALPHA_VANTAGE_API_KEY`: For trade chart visualization

**Mobile app support (optional):**
- `ACCESS_TOKEN_EXPIRE`: Access token expiry (default: 15m)
- `REFRESH_TOKEN_EXPIRE`: Refresh token expiry (default: 30d)
- `MAX_DEVICES_PER_USER`: Max devices per user (default: 10)
- `MAX_FILE_SIZE`: Max upload file size (default: 52428800)

### 3. Deploy

```bash
# Start the application
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f app
```

### 4. Initialize Database (First Time Only)

The database will be automatically created. To verify:

```bash
# Check if database is ready
docker exec tradetally-db pg_isready -U trader -d tradetally

# If you need to manually run the schema (only if tables don't exist):
# docker exec -i tradetally-db psql -U trader -d tradetally < schema.sql
```

### 5. Access the Application

- **TradeTally**: http://localhost
- **Database Admin**: http://localhost:8080 (optional)

## Default Login

Create your first user account through the registration page.

## Management Commands

### View Logs
```bash
docker-compose logs -f app
docker-compose logs -f postgres
```

### Update Application
```bash
# Pull latest image
docker-compose pull app

# Restart application (preserves database)
docker-compose up -d app
```

### Backup Database
```bash
docker exec tradetally-db pg_dump -U trader tradetally > tradetally_backup_$(date +%Y%m%d).sql
```

### Restore Database
```bash
docker exec -i tradetally-db psql -U trader tradetally < tradetally_backup.sql
```

### Stop Services
```bash
# Stop all services (preserves data)
docker-compose down

# Stop and remove volumes (WARNING: deletes all data)
docker-compose down -v
```

## Directory Structure

After deployment, your directory should look like:
```
tradetally/
├── docker-compose.yaml
├── .env
├── logs/          (created automatically)
└── data/          (created automatically)
```

## Troubleshooting

### Application won't start
```bash
# Check logs
docker-compose logs app

# Check database connection
docker exec tradetally-app ping postgres
```

### Database connection issues
```bash
# Check database status
docker-compose ps postgres

# Check database logs
docker-compose logs postgres
```

### Performance issues
- Ensure your server has at least 2GB RAM
- Check disk space for Docker volumes
- Monitor with: `docker stats`

## Security Notes

1. **Change default passwords** in `.env`
2. **Use a firewall** to restrict access to ports 5432 and 8080
3. **Set up SSL/TLS** with a reverse proxy like nginx for production
4. **Regular backups** of your database
5. **Keep Docker images updated**

## Fly.io Data Service (optionpartners-data)

The backend connects to a separate data-service for quotes, options chains, VIX, and macro regime. For Fly.io:

1. **Backend (optionpartners)** — `fly.toml` sets `DATA_SERVICE_URL=https://optionpartners-data.fly.dev`. Set the API key as a secret:
   ```bash
   fly secrets set DATA_SERVICE_API_KEY=<your-secure-key> -a optionpartners
   ```

2. **Data-service (optionpartners-data)** — Ensure `API_KEY` matches the backend's `DATA_SERVICE_API_KEY`:
   ```bash
   fly secrets set API_KEY=<same-key-as-above> -a optionpartners-data
   ```

3. **Verify connectivity:**
   ```bash
   curl -s https://optionpartners-data.fly.dev/api/health
   fly logs -a optionpartners  # Check for connectivity gate / data-service errors
   ```

## Simulation & Webhooks (Production Checklist)

When deploying with simulation trading and webhook ingestion:

1. **Run all pending migrations** before deploying. Migrations run automatically on startup (or manually via `node backend/src/utils/migrate.js`). The simulation and webhook features require migrations 177–183 (revenue target, webhook rate limits, processing metrics). If migrations fail, the app may start but webhook rate limiting will gracefully degrade.

2. **Operator alerts (optional)** — Set `OPERATOR_ALERT_WEBHOOK_URL` to a Slack/PagerDuty webhook URL if you want kill-switch activations and critical events to be notified. If unset, alerts are logged only.

3. **Safety guard tuning (optional)** — Defaults are usually sufficient:
   - `SIM_MAX_TRADES_PER_MINUTE=20` — Throttles rapid-fire signals
   - `SIM_MAX_MARGIN_PERCENT=0.5` — Max risk per trade as % of buying power
   Adjust only if your strategy requires different limits.

4. **Webhook rate limiting** — Uses `webhook_rate_limits` and related tables from migration 178. No separate enable/disable; it runs automatically. On database errors it allows requests through to avoid blocking legitimate traffic.

## Support

For issues and support:
- GitHub Issues: https://github.com/GeneBO98/tradetally/issues

## API Keys (Optional)

For full CUSIP resolution functionality:

1. **OpenFIGI API**: https://www.openfigi.com/api
2. **Google Gemini API**: https://console.cloud.google.com/

Add this to your `.env` file as `OPENFIGI_API_KEY`
