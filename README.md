# tristan-frontend## CI/CD (GitHub Actions → GHCR → VM)

Setiap push ke `main` otomatis: build image Docker → push ke `ghcr.io/michaeltristan8/tristan-frontend:latest` → SSH ke VM → `docker compose pull && up -d`.

### Setup sekali saja

**Repo → Settings → Environments → buat `production`**, lalu isi:

| Jenis | Nama | Isi |
|---|---|---|
| Variable | `VM_HOST` | IP / domain VM |
| Variable | `VM_USER` | user SSH di VM |
| Variable | `GHCR_USER` | `michaeltristan8` |
| Secret | `VM_SSH_KEY` | private key SSH (isi lengkap) |
| Secret | `GHCR_PAT` | Personal Access Token dengan scope `read:packages` |

**Di VM:** install Docker + Docker Compose plugin. Folder `~/apps/tristan-frontend` dan network `service-motor` dibuat otomatis oleh workflow.

Frontend (nginx) meneruskan `/api/*` ke container `service-motor-backend`, jadi aplikasi dibuka lewat `http://VM_HOST:8080`. Database SQLite disimpan di `~/apps/tristan-backend/data/`.
