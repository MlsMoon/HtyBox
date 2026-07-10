import { useEffect, useState } from "react";
import {
  getLanEnabled,
  getRelayConfig,
  getRelayStatus,
  pairingOffer,
  setLanEnabled,
  setRelayConfig,
  type PairingOffer,
} from "../catalog";

/** 小开关（与 SettingsModal 同风格，本组件自带以解耦）。 */
function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={"relative h-5 w-9 shrink-0 rounded-full transition-colors " + (on ? "bg-[var(--accent)]" : "bg-[var(--border)]")}
    >
      <span className={"absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all " + (on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

/** 设置「连接」区（L3）：展示监听端点 + LAN 开关 + 配对二维码/链接（手机扫码连接此 Host）。 */
export default function ConnectionSettings() {
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [lan, setLan] = useState(false);
  const [copied, setCopied] = useState(false);
  const [needRestart, setNeedRestart] = useState(false);
  const [relayEndpoint, setRelayEndpoint] = useState("");
  const [relayTls, setRelayTls] = useState(true);
  const [relayEnabled, setRelayEnabled] = useState(false);
  const [relayOnline, setRelayOnline] = useState(false);

  const reload = () => {
    pairingOffer()
      .then(setOffer)
      .catch(() => setOffer(null));
    getLanEnabled()
      .then(setLan)
      .catch(() => {});
    getRelayConfig()
      .then((c) => {
        setRelayEndpoint(c.endpoint ?? "");
        setRelayTls(c.useTls);
        setRelayEnabled(c.enabled);
        setRelayOnline(c.online);
      })
      .catch(() => {});
  };
  useEffect(reload, []);

  // relay 在线状态轮询（连接页打开期间）
  useEffect(() => {
    const i = setInterval(() => {
      getRelayStatus()
        .then(setRelayOnline)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(i);
  }, []);

  const toggleLan = async () => {
    const next = !lan;
    setLan(next);
    try {
      await setLanEnabled(next);
      setNeedRestart(true);
      reload();
    } catch {
      setLan(!next); // 失败回滚
    }
  };

  const saveRelay = (endpoint: string, tls: boolean, enabled: boolean) =>
    setRelayConfig(endpoint.trim() ? endpoint.trim() : null, tls, enabled).then(reload);

  const toggleRelay = async () => {
    const next = !relayEnabled;
    setRelayEnabled(next);
    try {
      await saveRelay(relayEndpoint, relayTls, next);
    } catch {
      setRelayEnabled(!next); // 失败回滚
    }
  };
  const toggleRelayTls = async () => {
    const next = !relayTls;
    setRelayTls(next);
    try {
      await saveRelay(relayEndpoint, next, relayEnabled);
    } catch {
      setRelayTls(!next);
    }
  };

  const copy = () => {
    if (!offer) return;
    navigator.clipboard
      .writeText(offer.offerUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="px-3 py-2.5">
      <div className="mb-3 text-[11px] leading-relaxed text-[var(--text-3)]">
        在手机上用 HtyBox 扫码或粘贴链接，即可远程查看 / 操控本机终端。支持局域网直连，或经 relay 中继远程访问（异地 / 蜂窝）。
      </div>

      <div className="mb-2 flex items-center justify-between gap-3 text-[12px]">
        <span className="text-[var(--text-2)]">
          监听 <code className="font-mono text-[var(--text)]">127.0.0.1:{offer?.port ?? "…"}</code>
          {lan && offer?.lanEndpoint ? (
            <>
              {" · LAN "}
              <code className="font-mono text-[var(--accent-text)]">{offer.lanEndpoint}</code>
            </>
          ) : null}
        </span>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-[var(--text)]">允许局域网（LAN）访问</div>
          <div className="text-[10.5px] text-[var(--text-3)]">开启后绑定 0.0.0.0，远程连接强制端到端加密</div>
        </div>
        <Toggle on={lan} onChange={toggleLan} />
      </div>
      {needRestart && (
        <div className="mb-3 rounded-md border border-[var(--accent-border)] bg-[var(--surface-soft)] px-2.5 py-1.5 text-[10.5px] text-[var(--accent-text)]">
          LAN 开关已更改，重启 HtyBox 后生效。
        </div>
      )}

      {/* L4：relay 远程中继（独立于 LAN，改动即时生效、无需重启） */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-[var(--text)]">relay 远程中继（异地 / 蜂窝）</div>
          <div className="text-[10.5px] text-[var(--text-3)]">Host 反连自托管中继，手机不在同 WiFi 也能连；relay 只转发端到端密文</div>
        </div>
        <Toggle on={relayEnabled} onChange={toggleRelay} />
      </div>
      {relayEnabled && (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-soft)] p-3">
          <label className="text-[10.5px] text-[var(--text-3)]">中继地址（host:port）</label>
          <input
            value={relayEndpoint}
            onChange={(e) => setRelayEndpoint(e.target.value)}
            onBlur={() => saveRelay(relayEndpoint, relayTls, relayEnabled)}
            placeholder="relay.example.com:443 或 127.0.0.1:6868"
            className="rounded-md border border-[var(--border)] bg-[var(--elevated)] px-2 py-1 font-mono text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-2)]">使用 TLS（wss，生产环境）</span>
            <Toggle on={relayTls} onChange={toggleRelayTls} />
          </div>
          <div className="flex items-center gap-1.5 text-[10.5px]">
            <span className={"h-2 w-2 rounded-full " + (relayOnline ? "bg-[#3fa563]" : "bg-[var(--border)]")} />
            <span className="text-[var(--text-3)]">
              {relayOnline ? "已接入中继" : relayEndpoint.trim() ? "未接入（连接中 / 检查地址 / 中继是否在线）" : "填写中继地址后启用"}
            </span>
          </div>
        </div>
      )}

      {lan || (relayEnabled && relayEndpoint.trim()) ? (
        offer && (offer.lanEndpoint || (relayEnabled && relayEndpoint.trim())) ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4">
            <div className="h-[220px] w-[220px] [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: offer.qrSvg }} />
            <div className="text-[10.5px] text-[var(--text-3)]">扫描二维码，或复制链接发到手机</div>
            <button
              onClick={copy}
              className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--accent-text)]"
            >
              {copied ? "已复制" : "复制配对链接"}
            </button>
          </div>
        ) : (
          <div className="text-[11px] text-[var(--text-3)]">正在生成配对信息…（LAN 需联网探测地址；relay 需填写中继地址）</div>
        )
      ) : (
        <div className="rounded-md bg-[var(--surface-soft)] px-3 py-2.5 text-[11px] text-[var(--text-3)]">
          开启「局域网访问」或配置 relay 中继后，在此显示配对二维码。
        </div>
      )}
    </div>
  );
}
