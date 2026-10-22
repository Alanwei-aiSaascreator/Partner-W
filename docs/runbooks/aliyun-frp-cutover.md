# 阿里云入口落地手册（frp + 泛解析 + 证书续期）

> 对应《荣盈魔方-手机网页远程控制-技术方案 v1.2》§5.5。
> 目标：手机浏览器打开 `https://<short8>.rym.rongyinghudong.com/app/` 能到客户机 18780。
> 一次性操作，预计 10 分钟；脚本在 `scripts/aliyun/`。

---

## 0. 先看三处坑（照抄 §5.5 会失败的地方）

| # | §5.5 原文 | 问题 | 正确做法 |
|---|---|---|---|
| 1 | 云解析加一条「主机记录 `*`」 | `*` 是整站泛解析。阿里云文档称其也能命中二级子域，但 RFC 语义只保证一级；而 `<short8>.rym...` 是**二级**子域，一旦不命中就是全链路 404。另外裸 `*` 会把 `mail/test/任意拼错的子域` 都指到这台 ECS | **必须加 `*.rym`（主机记录填 `*.rym`）**；裸 `*` 可选，不加也不影响本方案 |
| 2 | `listen 443 ssl;` + `http2 on;` | `http2 on;` 是 **nginx ≥ 1.25.1** 的写法；这台 ECS 是 **1.24.0**，会报 `unknown directive "http2"`，`nginx -t` 直接失败 → reload 失败，可能连累现有站点 | 1.24 用 `listen 443 ssl http2;`。脚本按 `nginx -v` 自动选写法 |
| 3 | 「frps 只监听本机」 | frps 没有「只绑回环」的默认行为，`vhostHTTPPort` 默认 `0.0.0.0:8080`，公网 IP 直接可达 | `frps.toml` 加 `proxyBindAddr = "127.0.0.1"`；并且**安全组不要放行 8080** |
| 4 | 直接 `acme.sh --issue` 后 nginx 才加载配置 | 证书文件不存在时 `nginx -t` 失败，配置上不去 | 先用自签证书占位（脚本已做），签发后覆盖同名文件再 reload |
| 5 | acme.sh 的密钥变量名 | acme.sh 的阿里云插件读 `Ali_Key` / `Ali_Secret`，不是 `ALI_ACCESS_KEY_*` | 脚本内做了映射，`.env.local` 里仍用你要的字段名 |

其余 §5.5 内容（`subDomainHost`、`auth.token`、`allowPorts`、frpc 的 `subdomain`）与实现一致，照用。

---

## 1. 云解析：加 `*.rym` A 记录

控制台路径：**云解析 DNS → 公网权威解析 → `rongyinghudong.com` → 解析设置 → 添加记录**

| 字段 | 填什么 |
|---|---|
| 记录类型 | `A` |
| 主机记录 | `*.rym` |
| 解析请求来源 | 默认 |
| 记录值 | `47.119.120.28` |
| TTL | `10 分钟`（600） |

保存后本机验证（Windows Git Bash / PowerShell 均可）：

```bash
nslookup test1234.rym.rongyinghudong.com
# 期望：Address: 47.119.120.28
```

等 1–2 分钟生效。若返回 NXDOMAIN，先确认主机记录是不是写成了 `*`（少了 `.rym`）。

> 不想点控制台，可用阿里云 CLI（用第 3 步的 AccessKey）：
> ```bash
> aliyun alidns AddDomainRecord --DomainName rongyinghudong.com \
>   --RR '*.rym' --Type A --Value 47.119.120.28 --TTL 600
> ```

可选补充（二期门户 `https://m.rongyinghudong.com/`）：另加一条 `m` → `47.119.120.28`。
不建议为了省事加裸 `*`：`api.rongyinghudong.com` 有精确记录不受影响，但任何拼错的单级子域都会落到这台 ECS 的默认 server 上，日后排查容易误判。

---

## 2. ECS：装 frps + nginx 配置

### 2.1 前置检查（30 秒）

```bash
# SSH 上机（阿里云控制台「远程连接」也可，免密钥）
sudo -i
nginx -v                     # 期望 nginx/1.24.0
ss -lntp | grep -E ':7000|:8080'   # 期望为空（没被占用）
ls /etc/nginx/conf.d/        # 确认 conf.d 目录存在且被 nginx.conf include
grep -rn "connection_upgrade" /etc/nginx/ | head   # 记下是否已定义
```

### 2.2 一键脚本

把 `scripts/aliyun/ecs-setup-frps.sh` 传上去再执行：

```bash
# 本机（Windows）上传
scp scripts/aliyun/ecs-setup-frps.sh root@47.119.120.28:/root/

# ECS 上
sudo -i
bash /root/ecs-setup-frps.sh
```

脚本输出末段会打印 **frp token**，记下来（第 4 步填进 frpc.toml）。

脚本做的事：
1. 下载 `frp_0.68.0_linux_amd64`（GitHub → ghfast.top → gh-proxy.com 三级回退），装 `frps`/`frpc` 到 `/usr/local/bin`；
2. 建系统用户 `frp`，写 `/etc/frp/frps.toml`（`proxyBindAddr=127.0.0.1`、`transport.tls.force=true`、`allowPorts` 只留 7000），`chmod 640 root:frp`；
3. `frps verify -c` 校验语法 → 注册 `frps.service`（非 root、`ProtectSystem=strict`）→ 启动；
4. 证书缺失时用自签占位（30 天），保证 nginx 可起；
5. 按 nginx 版本写 `listen`/`http2`，新增 `00-frp-connection-upgrade.conf` 与 `rym-frp.conf`（**不动任何既有 server 块**），`nginx -t` 失败自动回滚并保留 `.bak`；
6. 防火墙放行 7000/tcp（firewalld/ufw 自动识别），**不放行 8080**；
7. 自检：`ss -lntp` + `curl 127.0.0.1:8080`。

期望输出：

```
frps tcp listen on 0.0.0.0:7000
http service listen on 127.0.0.1:8080
本机访问 frps vhost 返回 HTTP 404（404 = frps 在跑但没有 frpc 上线，正常）
```

### 2.3 安全组（脚本管不到，必须手点）

**ECS → 实例 → 安全组 → 配置规则 → 入方向 → 手动添加**

| 端口范围 | 授权对象 | 用途 |
|---|---|---|
| `7000/7000` | `0.0.0.0/0` | frpc 客户机连入（分布在全国，不能收窄） |
| `80/80`、`443/443` | `0.0.0.0/0` | 已存在，确认有即可 |
| `8080` | **不要加** | 只走回环，加了等于给公网开后门 |

### 2.4 验证（此时还没有 frpc，只能验到 nginx 层）

```bash
curl -sI http://127.0.0.1:8080/ | head -3        # 404，frps 正常
curl -sI https://test1234.rym.rongyinghudong.com/ | head -3
# 证书还是自签时会报证书错误，加 -k 应先看到 404
```

### 2.5 等价手动步骤（不想跑脚本）

```bash
# 1) 装二进制
curl -fL -o /tmp/frp.tar.gz https://github.com/fatedier/frp/releases/download/v0.68.0/frp_0.68.0_linux_amd64.tar.gz
tar -xzf /tmp/frp.tar.gz -C /tmp && install -m755 /tmp/frp_0.68.0_linux_amd64/frps /usr/local/bin/
# 2) 配置：把 §5.5 的 frps.toml 抄进 /etc/frp/frps.toml，另加一行
#    proxyBindAddr = "127.0.0.1"
# 3) systemd：/etc/systemd/system/frps.service，ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
# 4) nginx：§5.5 的 server 块存成 /etc/nginx/conf.d/rym-frp.conf，
#    并把 "listen 443 ssl; http2 on;" 改成 "listen 443 ssl http2;"
# 5) map 块（若 /etc/nginx 里没有）：
#    echo 'map $http_upgrade $connection_upgrade { default upgrade; "" close; }' \
#      > /etc/nginx/conf.d/00-frp-connection-upgrade.conf
# 6) nginx -t && systemctl reload nginx && systemctl enable --now frps
```

---

## 3. RAM 子账号 + AccessKey + `.env.local`

### 3.1 建子账号

**控制台右上角头像 → 访问控制 RAM → 身份管理 → 用户 → 创建用户**

1. 登录名称：`acme-dns`（显示名 `证书续期-DNS`）
2. 访问方式：**只勾「使用永久 AccessKey 访问」**（OpenAPI 调用）。不要勾「控制台访问」，少一个密码面。
3. 创建完成后**立刻**复制 `AccessKey ID` 与 `AccessKey Secret`（Secret 只显示这一次）。

### 3.2 只给 DNS 权限

**用户 → acme-dns → 权限管理 → 新增授权**

- 授权范围：**整个云账号**（DNS 是全局资源，指定资源组也无法细到 zone，除非写自定义策略）
- 策略：搜索并勾选 `AliyunDNSFullAccess`

> 更紧的做法（可选，2 分钟）：自定义策略只允许操作 `rongyinghudong.com` 这一条 zone：
> ```json
> {
>   "Version": "1",
>   "Statement": [{
>     "Effect": "Allow",
>     "Action": ["alidns:AddDomainRecord","alidns:DeleteDomainRecord",
>                "alidns:DescribeDomainRecords","alidns:DescribeDomains"],
>     "Resource": ["acs:alidns:*:*:domain/rongyinghudong.com"]
>   }]
> }
> ```
> 系统策略 `AliyunDNSFullAccess` 能改本账号所有域名的解析；自定义策略只限这一个域名。先用系统策略跑通，再收窄也行。

### 3.3 加 IP 白名单（可选，强烈建议）

**用户 → acme-dns → 认证管理 → AccessKey 网络访问限制 → 限定 IP**
填 `47.119.120.28`（ECS 公网出口）。这样即使密钥泄露，也只能从这台机器调用。

### 3.4 写进 `.env.local`

文件：`C:\Users\wei\projects\mofang-drift-clean\.env.local`（已在 `.gitignore`，不会进仓库）

```dotenv
# 阿里云 RAM 子账号（仅 AliyunDNSFullAccess，给 acme.sh DNS-01 自动续期用）
ALI_ACCESS_KEY_ID=LTAI5t****************
ALI_ACCESS_KEY_SECRET=********************************
```

字段名已按你的要求预置好，只差粘值。

### 3.5 签发通配证书（在 ECS 上跑）

```bash
# 方式 A：把两个值临时 export（推荐，不落盘到 ECS）
export ALI_ACCESS_KEY_ID=LTAI5t****************
export ALI_ACCESS_KEY_SECRET=********************************
bash /root/issue-wildcard-cert.sh

# 方式 B：把本机 .env.local 传上去再 source（注意删文件）
scp .env.local root@47.119.120.28:/root/.ali.env
set -a; . /root/.ali.env; set +a; shred -u /root/.ali.env
```

脚本用 `dns_ali` 做 DNS-01，签发 `*.rym.rongyinghudong.com` + `rym.rongyinghudong.com`（RSA 2048），
安装到 `/etc/nginx/certs/rym/{fullchain,privkey}.pem` 并设置续期后 `systemctl reload nginx`。
acme.sh 自装 cron（每日），**不需要 certbot**。

验证：

```bash
openssl x509 -in /etc/nginx/certs/rym/fullchain.pem -noout -subject -dates -ext subjectAltName
# 期望 SAN: DNS:*.rym.rongyinghudong.com, DNS:rym.rongyinghudong.com
curl -sI https://test1234.rym.rongyinghudong.com/ | head -3   # 200/404 且无证书告警
crontab -l | grep acme                                         # 有续期任务
```

---

## 4. 端到端验收

在客户机上放一个临时 frpc 配置（桌面壳接管前手工验证）：

```toml
# /tmp/frpc.toml
serverAddr = "47.119.120.28"
serverPort = 7000
loginFailExit = false
transport.tls.enable = true
auth.method = "token"
auth.token = "<步骤 2.2 打印的 token>"

[[proxies]]
name = "test1234"
type = "http"
localIP = "127.0.0.1"
localPort = 18780
subdomain = "test1234"
```

```bash
frpc -c /tmp/frpc.toml
# 另一个窗口 / 手机 4G：
curl -sI https://test1234.rym.rongyinghudong.com/app/
```

判据：

| 现象 | 含义 |
|---|---|
| 404 页来自 frps | nginx + frps 通，frpc 没上（查 token/7000 安全组） |
| 502 / `no backend` | frpc 在，但客户机 18780 没起（桌面壳没开） |
| 200 且有 `no-store` 头 | 全链路通 |

---

## 5. 回滚（3 条命令）

```bash
systemctl disable --now frps
rm -f /etc/nginx/conf.d/rym-frp.conf /etc/nginx/conf.d/00-frp-connection-upgrade.conf
nginx -t && systemctl reload nginx
# 云解析删掉 *.rym 记录；安全组删掉 7000
```

既有站点不受影响：本方案只新增文件，未修改任何原 server 块。
