import { useEffect, useState } from 'react';
import { Bell, Mail, MessageSquare, Save, CheckCircle2, Zap, Loader2, Shield, Send, TrendingUp, TrendingDown, Building } from 'lucide-react';
import { api } from '../services/api';
import { NotificationConfig, SmtpConfig, WecomConfig } from '../types';
import { useAuth } from '../context/AuthContext';

type NotificationChannel = 'email' | 'wechat' | 'dingtalk' | 'feishu';

type SmtpDraft = {
  host: string;
  port: number;
  user: string;
  from: string;
  pass: string;
};

export default function Notifications() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [testingChannel, setTestingChannel] = useState<NotificationChannel | null>(null);
  const [smtpConfig, setSmtpConfig] = useState<SmtpConfig | null>(null);
  const [smtpDraft, setSmtpDraft] = useState<SmtpDraft>({ host: '', port: 465, user: '', from: '', pass: '' });
  const [smtpSaveStatus, setSmtpSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [isTestingSmtp, setIsTestingSmtp] = useState(false);
  const [wecomConfig, setWecomConfig] = useState<WecomConfig | null>(null);
  const [wecomDraft, setWecomDraft] = useState<{
    enabled: boolean;
    corpId: string;
    agentId: string;
    secret: string;
    toUser: string;
  }>({ enabled: false, corpId: '', agentId: '', secret: '', toUser: '@all' });
  const [wecomSaveStatus, setWecomSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [isTestingWecom, setIsTestingWecom] = useState(false);

  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    loadSmtpConfig();
    loadWecomConfig();
  }, [isAdmin]);

  const loadConfig = async () => {
    setIsLoading(true);
    try {
      const data = await api.getNotificationConfig();
      setConfig({
        ...data,
        triggerValue: Number((data as any).triggerValue ?? 0),
        notifyOnPriceUp: !!(data as any).notifyOnPriceUp,
      });
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadSmtpConfig = async () => {
    try {
      const data = await api.getSmtpConfig();
      setSmtpConfig(data);
      setSmtpDraft({
        host: data.host,
        port: Number(data.port),
        user: data.user,
        from: data.from,
        pass: '',
      });
    } catch (error) {
      console.error('Failed to load SMTP config:', error);
    }
  };

  const loadWecomConfig = async () => {
    try {
      const data = await api.getWecomConfig();
      setWecomConfig(data);
      setWecomDraft({
        enabled: data.enabled,
        corpId: data.corpId,
        agentId: data.agentId ? String(data.agentId) : '',
        secret: '',
        toUser: data.toUser || '@all',
      });
    } catch (error) {
      console.error('Failed to load WeCom config:', error);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaveStatus('saving');
    try {
      await api.updateNotificationConfig(config);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (error) {
      console.error('Failed to save config:', error);
      setSaveStatus('idle');
    }
  };

  const handleTest = async (channel: NotificationChannel) => {
    if (!config) return;
    setTestingChannel(channel);

    try {
      const testConfig: Record<string, string | undefined> = {};
      if (channel === 'email') testConfig.emailAddress = config.emailAddress || undefined;
      if (channel === 'wechat') testConfig.wechatWebhook = config.wechatWebhook || undefined;
      if (channel === 'dingtalk') testConfig.dingtalkWebhook = config.dingtalkWebhook || undefined;
      if (channel === 'feishu') testConfig.feishuWebhook = config.feishuWebhook || undefined;

      const result = await api.testNotification(channel, testConfig);
      if (result.success) {
        alert('测试消息发送成功！');
      } else {
        alert(`发送失败: ${result.error}`);
      }
    } catch (error) {
      alert('测试失败');
    } finally {
      setTestingChannel(null);
    }
  };

  const handleSmtpSave = async () => {
    setSmtpSaveStatus('saving');
    try {
      const payload: Record<string, unknown> = {
        host: smtpDraft.host,
        port: smtpDraft.port,
        user: smtpDraft.user,
        from: smtpDraft.from,
      };

      if (smtpDraft.pass.trim()) {
        payload.pass = smtpDraft.pass;
      }

      const next = await api.updateSmtpConfig(payload as any);
      setSmtpConfig(next);
      setSmtpDraft((prev) => ({
        ...prev,
        pass: '',
      }));
      setSmtpSaveStatus('saved');
      setTimeout(() => setSmtpSaveStatus('idle'), 3000);
    } catch (error) {
      console.error('Failed to save SMTP config:', error);
      setSmtpSaveStatus('idle');
    }
  };

  const handleSmtpTest = async () => {
    if (!isAdmin) return;
    const to = window.prompt('请输入接收邮箱地址（用于发送测试邮件）');
    if (!to) return;

    setIsTestingSmtp(true);
    try {
      const result = await api.testSmtp(to);
      if (result.success) {
        alert('测试邮件发送成功！');
      } else {
        alert(`发送失败: ${result.error}`);
      }
    } catch (error) {
      alert('测试失败');
    } finally {
      setIsTestingSmtp(false);
    }
  };

  const handleWecomSave = async () => {
    setWecomSaveStatus('saving');
    try {
      const payload: Record<string, unknown> = {
        enabled: wecomDraft.enabled,
        corpId: wecomDraft.corpId.trim(),
        toUser: wecomDraft.toUser.trim() || '@all',
      };

      const agentId = parseInt(wecomDraft.agentId, 10);
      if (Number.isFinite(agentId) && agentId > 0) {
        payload.agentId = agentId;
      }

      if (wecomDraft.secret.trim()) {
        payload.secret = wecomDraft.secret.trim();
      }

      const next = await api.updateWecomConfig(payload as any);
      setWecomConfig(next);
      setWecomDraft((prev) => ({
        ...prev,
        secret: '',
        agentId: next.agentId ? String(next.agentId) : prev.agentId,
        toUser: next.toUser || prev.toUser,
      }));
      setWecomSaveStatus('saved');
      setTimeout(() => setWecomSaveStatus('idle'), 3000);
    } catch (error) {
      console.error('Failed to save WeCom config:', error);
      setWecomSaveStatus('idle');
    }
  };

  const handleWecomTest = async () => {
    if (!isAdmin) return;
    setIsTestingWecom(true);
    try {
      const result = await api.testWecom();
      if (result.success) {
        alert('测试消息发送成功！');
      } else {
        alert(`发送失败: ${result.error}`);
      }
    } catch (error) {
      alert('测试失败');
    } finally {
      setIsTestingWecom(false);
    }
  };

  const updateConfig = (updates: Partial<NotificationConfig>) => {
    if (!config) return;
    setConfig({ ...config, ...updates });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!config) {
    return <div className="text-center text-gray-500">加载失败</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Bell className="w-6 h-6 text-orange-500" />
          通知设置
        </h2>
        <p className="text-gray-500 mt-1">配置降价提醒的通知方式和触发条件（仅对当前登录账号生效）</p>
      </div>

      {/* Global Triggers Section */}
      <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-gray-50/50">
          <h3 className="font-bold text-gray-800 flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500" />
            触发条件
          </h3>
        </div>
        <div className="p-6 space-y-6">
          {/* Threshold Input */}
          <div>
            <label className="text-sm font-bold text-gray-700 block mb-3">触发阈值</label>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex items-center gap-2 bg-gray-100 p-1 rounded-lg">
                <button
                  onClick={() => updateConfig({ triggerType: 'AMOUNT' })}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                    config.triggerType === 'AMOUNT'
                      ? 'bg-white shadow text-gray-900'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  固定金额 (¥)
                </button>
                <button
                  onClick={() => updateConfig({ triggerType: 'PERCENT' })}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                    config.triggerType === 'PERCENT'
                      ? 'bg-white shadow text-gray-900'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  百分比 (%)
                </button>
              </div>
              <div className="relative w-full sm:w-32">
                <input
                  type="number"
                  value={config.triggerValue}
                  onChange={(e) => updateConfig({ triggerValue: Number(e.target.value) })}
                  className="w-full pl-4 pr-8 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none"
                />
                <span className="absolute right-3 top-2.5 text-gray-400 text-sm font-medium">
                  {config.triggerType === 'AMOUNT' ? '¥' : '%'}
                </span>
              </div>
              <p className="text-xs text-gray-500 pt-1 sm:pt-0">
                当价格变动幅度超过此值时触发通知
              </p>
            </div>
          </div>

          <div className="h-px bg-gray-100" />

          {/* Directions */}
          <div>
            <label className="text-sm font-bold text-gray-700 block mb-3">监控方向</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Price Drop (Always Active) */}
              <div className="flex items-center gap-3 p-3 rounded-xl border border-green-200 bg-green-50/50">
                <div className="p-2 bg-green-100 rounded-lg text-green-600">
                  <TrendingDown className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-gray-900 text-sm">价格下降</div>
                  <div className="text-xs text-green-700 mt-0.5">总是通知</div>
                </div>
                <div className="ml-auto">
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                </div>
              </div>

              {/* Price Rise (Toggle) */}
              <div
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                  config.notifyOnPriceUp
                    ? 'border-red-200 bg-red-50/50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
                onClick={() => updateConfig({ notifyOnPriceUp: !config.notifyOnPriceUp })}
              >
                <div
                  className={`p-2 rounded-lg transition-colors ${
                    config.notifyOnPriceUp ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div>
                  <div
                    className={`font-bold text-sm ${
                      config.notifyOnPriceUp ? 'text-gray-900' : 'text-gray-500'
                    }`}
                  >
                    价格上涨
                  </div>
                  <div
                    className={`text-xs mt-0.5 ${
                      config.notifyOnPriceUp ? 'text-red-700' : 'text-gray-400'
                    }`}
                  >
                    {config.notifyOnPriceUp ? '已开启通知' : '不通知'}
                  </div>
                </div>
                <div className="ml-auto">
                  {/* Toggle Switch */}
                  <div
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      config.notifyOnPriceUp ? 'bg-red-500' : 'bg-gray-200'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition shadow-sm ${
                        config.notifyOnPriceUp ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Channels */}
      <div className="space-y-4">
        {/* Email */}
        <div
          className={`bg-white rounded-2xl border transition-all ${
            config.emailEnabled
              ? 'border-orange-200 shadow-sm ring-1 ring-orange-500/10'
              : 'border-gray-200 opacity-80'
          }`}
        >
          <div className="p-6 flex items-start justify-between gap-4">
            <div className="flex gap-4">
              <div
                className={`p-3 rounded-xl ${
                  config.emailEnabled ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'
                }`}
              >
                <Mail className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 text-lg">邮件通知</h3>
                <p className="text-sm text-gray-500 mt-1">将降价提醒发送到您的邮箱</p>
              </div>
            </div>
            <button
              onClick={() => updateConfig({ emailEnabled: !config.emailEnabled })}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                config.emailEnabled ? 'bg-orange-500' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition shadow-sm ${
                  config.emailEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          {config.emailEnabled && (
            <div className="px-6 pb-6 border-t border-gray-100 pt-6">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">接收邮箱</label>
              <input
                type="email"
                value={config.emailAddress || ''}
                onChange={(e) => updateConfig({ emailAddress: e.target.value })}
                placeholder="your@email.com"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
              />
              <div className="pt-4 flex justify-end">
                <button
                  onClick={() => handleTest('email')}
                  disabled={testingChannel === 'email' || !config.emailAddress}
                  className="text-sm font-medium text-orange-600 px-4 py-2 bg-orange-50 hover:bg-orange-100 rounded-lg disabled:opacity-50"
                >
                  {testingChannel === 'email' ? '发送中...' : '发送测试'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* WeChat */}
        <div
          className={`bg-white rounded-2xl border transition-all ${
            config.wechatEnabled
              ? 'border-orange-200 shadow-sm ring-1 ring-orange-500/10'
              : 'border-gray-200 opacity-80'
          }`}
        >
          <div className="p-6 flex items-start justify-between gap-4">
            <div className="flex gap-4">
              <div
                className={`p-3 rounded-xl ${
                  config.wechatEnabled ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'
                }`}
              >
                <MessageSquare className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 text-lg">微信通知</h3>
                <p className="text-sm text-gray-500 mt-1">通过企业微信 Webhook 或 Server酱推送</p>
              </div>
            </div>
            <button
              onClick={() => updateConfig({ wechatEnabled: !config.wechatEnabled })}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                config.wechatEnabled ? 'bg-orange-500' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition shadow-sm ${
                  config.wechatEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          {config.wechatEnabled && (
            <div className="px-6 pb-6 border-t border-gray-100 pt-6">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Webhook URL / SendKey
              </label>
              <input
                type="text"
                value={config.wechatWebhook || ''}
                onChange={(e) => updateConfig({ wechatWebhook: e.target.value })}
                placeholder="https://sctapi.ftqq.com/xxx.send"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
              />
              <div className="pt-4 flex justify-end">
                <button
                  onClick={() => handleTest('wechat')}
                  disabled={testingChannel === 'wechat' || !config.wechatWebhook}
                  className="text-sm font-medium text-orange-600 px-4 py-2 bg-orange-50 hover:bg-orange-100 rounded-lg disabled:opacity-50"
                >
                  {testingChannel === 'wechat' ? '发送中...' : '发送测试'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* DingTalk */}
        <div
          className={`bg-white rounded-2xl border transition-all ${
            config.dingtalkEnabled
              ? 'border-orange-200 shadow-sm ring-1 ring-orange-500/10'
              : 'border-gray-200 opacity-80'
          }`}
        >
          <div className="p-6 flex items-start justify-between gap-4">
            <div className="flex gap-4">
              <div
                className={`p-3 rounded-xl ${
                  config.dingtalkEnabled ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'
                }`}
              >
                <MessageSquare className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 text-lg">钉钉通知</h3>
                <p className="text-sm text-gray-500 mt-1">通过钉钉群机器人 Webhook 推送消息</p>
              </div>
            </div>
            <button
              onClick={() => updateConfig({ dingtalkEnabled: !config.dingtalkEnabled })}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                config.dingtalkEnabled ? 'bg-orange-500' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition shadow-sm ${
                  config.dingtalkEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          {config.dingtalkEnabled && (
            <div className="px-6 pb-6 border-t border-gray-100 pt-6">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Webhook URL</label>
              <input
                type="text"
                value={config.dingtalkWebhook || ''}
                onChange={(e) => updateConfig({ dingtalkWebhook: e.target.value })}
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
              />
              <div className="pt-4 flex justify-end">
                <button
                  onClick={() => handleTest('dingtalk')}
                  disabled={testingChannel === 'dingtalk' || !config.dingtalkWebhook}
                  className="text-sm font-medium text-orange-600 px-4 py-2 bg-orange-50 hover:bg-orange-100 rounded-lg disabled:opacity-50"
                >
                  {testingChannel === 'dingtalk' ? '发送中...' : '发送测试'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Feishu */}
        <div
          className={`bg-white rounded-2xl border transition-all ${
            config.feishuEnabled
              ? 'border-orange-200 shadow-sm ring-1 ring-orange-500/10'
              : 'border-gray-200 opacity-80'
          }`}
        >
          <div className="p-6 flex items-start justify-between gap-4">
            <div className="flex gap-4">
              <div
                className={`p-3 rounded-xl ${
                  config.feishuEnabled ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'
                }`}
              >
                <MessageSquare className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 text-lg">飞书通知</h3>
                <p className="text-sm text-gray-500 mt-1">通过飞书群机器人 Webhook 推送消息</p>
              </div>
            </div>
            <button
              onClick={() => updateConfig({ feishuEnabled: !config.feishuEnabled })}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                config.feishuEnabled ? 'bg-orange-500' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition shadow-sm ${
                  config.feishuEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          {config.feishuEnabled && (
            <div className="px-6 pb-6 border-t border-gray-100 pt-6">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Webhook URL</label>
              <input
                type="text"
                value={config.feishuWebhook || ''}
                onChange={(e) => updateConfig({ feishuWebhook: e.target.value })}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
              />
              <div className="pt-4 flex justify-end">
                <button
                  onClick={() => handleTest('feishu')}
                  disabled={testingChannel === 'feishu' || !config.feishuWebhook}
                  className="text-sm font-medium text-orange-600 px-4 py-2 bg-orange-50 hover:bg-orange-100 rounded-lg disabled:opacity-50"
                >
                  {testingChannel === 'feishu' ? '发送中...' : '发送测试'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {isAdmin && smtpConfig && (
        <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-100 bg-gray-50/50">
            <h3 className="font-bold text-gray-800 flex items-center gap-2">
              <Shield className="w-4 h-4 text-orange-500" />
              发件邮箱（管理员）
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Host</label>
                <input
                  type="text"
                  value={smtpDraft.host}
                  onChange={(e) => setSmtpDraft((prev) => ({ ...prev, host: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Port</label>
                <input
                  type="number"
                  value={smtpDraft.port}
                  onChange={(e) => setSmtpDraft((prev) => ({ ...prev, port: Number(e.target.value) }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">User</label>
                <input
                  type="text"
                  value={smtpDraft.user}
                  onChange={(e) => setSmtpDraft((prev) => ({ ...prev, user: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">From</label>
                <input
                  type="text"
                  value={smtpDraft.from}
                  onChange={(e) => setSmtpDraft((prev) => ({ ...prev, from: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
              <input
                type="password"
                value={smtpDraft.pass}
                onChange={(e) => setSmtpDraft((prev) => ({ ...prev, pass: e.target.value }))}
                placeholder={smtpConfig.hasPass ? '如需修改密码，请在此输入新密码' : '请输入密码'}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none"
              />
            </div>

            <div className="pt-2 flex flex-col sm:flex-row justify-end gap-3">
              <button
                onClick={handleSmtpTest}
                disabled={isTestingSmtp}
                className="text-sm font-medium text-orange-600 px-4 py-2 bg-orange-50 hover:bg-orange-100 rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                {isTestingSmtp ? '发送中...' : '发送测试'}
              </button>
              <button
                onClick={handleSmtpSave}
                disabled={smtpSaveStatus === 'saving'}
                className="text-sm font-bold text-white px-4 py-2 bg-gray-900 hover:bg-gray-800 rounded-lg disabled:opacity-50"
              >
                {smtpSaveStatus === 'saving'
                  ? '保存中...'
                  : smtpSaveStatus === 'saved'
                    ? '已保存'
                    : '保存发件配置'}
              </button>
            </div>
          </div>
        </section>
      )}

      {isAdmin && wecomConfig && (
        <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-100 bg-gray-50/50">
            <h3 className="font-bold text-gray-800 flex items-center gap-2">
              <Building className="w-4 h-4 text-blue-500" />
              企业微信应用（管理员）
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-gray-700">启用状态</span>
              <button
                onClick={() => setWecomDraft((prev) => ({ ...prev, enabled: !prev.enabled }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  wecomDraft.enabled ? 'bg-blue-500' : 'bg-gray-200'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition shadow-sm ${
                    wecomDraft.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Corp ID</label>
                <input
                  type="text"
                  value={wecomDraft.corpId}
                  onChange={(e) => setWecomDraft((prev) => ({ ...prev, corpId: e.target.value }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Agent ID</label>
                <input
                  type="text"
                  value={wecomDraft.agentId}
                  onChange={(e) => setWecomDraft((prev) => ({ ...prev, agentId: e.target.value }))}
                  placeholder="1000003"
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Secret</label>
                <input
                  type="password"
                  value={wecomDraft.secret}
                  onChange={(e) => setWecomDraft((prev) => ({ ...prev, secret: e.target.value }))}
                  placeholder={wecomConfig.hasSecret ? '如需修改 Secret，请在此输入' : '请输入 Secret'}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">To User</label>
                <input
                  type="text"
                  value={wecomDraft.toUser}
                  onChange={(e) => setWecomDraft((prev) => ({ ...prev, toUser: e.target.value }))}
                  placeholder="@all"
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none"
                />
              </div>
            </div>

            <div className="pt-2 flex flex-col sm:flex-row justify-end gap-3">
              <button
                onClick={handleWecomTest}
                disabled={isTestingWecom}
                className="text-sm font-medium text-blue-600 px-4 py-2 bg-blue-50 hover:bg-blue-100 rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                {isTestingWecom ? '发送中...' : '发送测试'}
              </button>
              <button
                onClick={handleWecomSave}
                disabled={wecomSaveStatus === 'saving'}
                className="text-sm font-bold text-white px-4 py-2 bg-gray-900 hover:bg-gray-800 rounded-lg disabled:opacity-50"
              >
                {wecomSaveStatus === 'saving'
                  ? '保存中...'
                  : wecomSaveStatus === 'saved'
                    ? '已保存'
                    : '保存企业微信配置'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Save Action Bar */}
      <div className="sticky bottom-20 md:bottom-4 bg-white/80 backdrop-blur-md border border-gray-200 p-4 rounded-2xl shadow-lg flex justify-between items-center">
        <div className="text-sm text-gray-500 pl-2">
          {saveStatus === 'saved' ? (
            <span className="flex items-center gap-2 text-green-600 font-medium">
              <CheckCircle2 className="w-4 h-4" /> 设置已保存
            </span>
          ) : (
            <span>记得保存您的更改</span>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-white transition-all ${
            saveStatus === 'saved' ? 'bg-green-500' : 'bg-gray-900 hover:bg-gray-800'
          }`}
        >
          {saveStatus === 'saving' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saveStatus === 'saved' ? '已保存' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
