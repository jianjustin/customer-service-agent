import { useEffect, useState } from "react";
import { api } from "./api";
import { ModeBadge } from "./components/ModeBadge";
import { usePolling } from "./hooks/usePolling";
import { AgentPage } from "./pages/AgentPage";
import { CustomerPage } from "./pages/CustomerPage";
import { ReviewerPage } from "./pages/ReviewerPage";
import type { BootstrapResp } from "./types";

type Route = "customer" | "agent" | "reviewer";

const NAV: { route: Route; label: string }[] = [
  { route: "customer", label: "客户端" },
  { route: "agent", label: "客服工作台" },
  { route: "reviewer", label: "审核台" },
];

function parseRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  return h === "agent" || h === "reviewer" ? h : "customer";
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // bootstrap 低频轮询：后端晚于前端启动时可自动恢复，席位在线状态也能保持新鲜
  const bootstrap = usePolling(() => api<BootstrapResp>(null, "GET", "/bootstrap"), [], 5000);
  const boot = bootstrap.data;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">企业客服 Agent 演示</div>
        <nav>
          {NAV.map((n) => (
            <a key={n.route} href={`#/${n.route}`} className={route === n.route ? "active" : ""}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <ModeBadge model={boot?.model ?? null} />
        </div>
      </header>
      <main className="main">
        {route === "customer" && <CustomerPage customers={boot?.customers ?? null} />}
        {route === "agent" && <AgentPage seats={boot?.seats ?? null} />}
        {route === "reviewer" && <ReviewerPage reviewers={boot?.reviewers ?? null} />}
      </main>
    </div>
  );
}
