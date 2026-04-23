# AFK Bot Runner

Runner chạy bot AFK DonutSMP trên GitHub Actions. Được điều khiển bởi **Local Manager** (repo riêng) qua GitHub REST API.

## Kiến trúc

```
Local Manager (máy bạn)          GitHub (public repo)
┌──────────────┐   PAT API      ┌────────────────────┐
│ UI dashboard │───────────────>│ Actions workflow   │
│ MSA cache    │  Upload secret │ .github/afk.yml    │
│ Webhook srv  │<───────────────│ Bot (afk-worker.js)│
│ (ngrok)      │   HTTP logs    │ - raknet-native    │
└──────────────┘                │ - auto-exit 5h40m  │
                                │ - chain self-restart│
                                └────────────────────┘
```

## Cấu hình

### Secrets cần tạo (Settings → Secrets → Actions)

| Tên | Nội dung |
|-----|----------|
| `MSA_CACHE_<ACCOUNT_ID>` | Base64 của file `.auth-cache/<ACCOUNT_ID>/bed-cache.json` |

Manager local sẽ tự động upload secret này khi bạn click Deploy.

### Workflow permissions

Settings → Actions → General → Workflow permissions → **Read and write permissions**
(cần để job chain tự trigger job kế tiếp).

## Trigger thủ công

Actions → AFK Bot → Run workflow, điền:
- `account_id`: khớp với hậu tố của secret `MSA_CACHE_<id>`
- `webhook_url`: HTTPS URL manager (ngrok/cloudflare)
- `webhook_token`: token xác thực
- `areas` (tùy chọn): `10,20,30,...`
- `run_duration_sec`: mặc định `20400` (5h40m)
- `chain`: `true` để auto-restart, `false` one-shot

## Lưu ý

- **Repo public**: secrets vẫn được GitHub encrypt, nhưng hạn chế write-access cho người khác
- **MSA refresh token** sống ~90 ngày. Khi hết hạn, runner log `LOGIN XBOX REQUIRED` và gửi webhook về manager để bạn đăng nhập lại
- **Connectivity**: GitHub runners có public IP, UDP 19132 tới `donutsmp.net` hoạt động bình thường không cần proxy
