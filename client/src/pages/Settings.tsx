import React, { useEffect, useState } from 'react';
import { Settings as SettingsIcon, Save, CheckCircle2, Shield, Clock, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { ScraperConfig } from '../types';

export default function Settings() {
  const [config, setConfig] = useState<ScraperConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setIsLoading(true);
    try {
      const data = await api.getScraperConfig();
      setConfig(data);
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaveStatus('saving');
    try {
      await api.updateScraperConfig(config);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (error) {
      console.error('Failed to save config:', error);
      setSaveStatus('idle');
    }
  };

  const updateConfig = (updates: Partial<ScraperConfig>) => {
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

  const hasValidationError = config.minDelay > config.maxDelay;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <SettingsIcon className="w-6 h-6 text-orange-500" />
          系统设置
        </h2>
        <p className="text-gray-500 mt-1">配置爬虫行为和系统参数</p>
      </div>

      {/* Anti-detection Delay */}
      <section className="bg-white rounded-2xl shadow-sm border border-orange-200 overflow-hidden ring-1 ring-orange-500/10">
        <div className="p-6 border-b border-gray-100 bg-orange-50/30">
          <h3 className="font-bold text-gray-800 flex items-center gap-2 text-lg">
            <Shield className="w-5 h-5 text-orange-600" />
            防风控随机延迟
          </h3>
          <p className="text-sm text-gray-500 mt-1 ml-7">
            在每次抓取任务之间增加随机等待时间，模拟真实用户行为，降低被淘宝封锁的风险。
          </p>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">最小延迟</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  value={config.minDelay}
                  onChange={(e) => updateConfig({ minDelay: parseInt(e.target.value) || 0 })}
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-200 rounded-xl focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition-all"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">秒</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">最大延迟</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  value={config.maxDelay}
                  onChange={(e) => updateConfig({ maxDelay: parseInt(e.target.value) || 0 })}
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-200 rounded-xl focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition-all"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">秒</span>
              </div>
            </div>
          </div>

          {hasValidationError && (
            <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
              <AlertTriangle className="w-4 h-4" />
              最小延迟不能大于最大延迟
            </div>
          )}

          <div className="text-sm text-gray-500 bg-gray-50 p-4 rounded-xl">
            <span className="font-medium text-gray-700">当前生效：</span>
            每次抓取将在 <span className="text-orange-600 font-bold">{config.minDelay}</span> 到 <span className="text-orange-600 font-bold">{config.maxDelay}</span> 秒之间随机等待。
          </div>
        </div>
      </section>

      {/* Polling Interval */}
      <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-gray-50/50">
          <h3 className="font-bold text-gray-800 flex items-center gap-2 text-lg">
            <Clock className="w-5 h-5 text-gray-600" />
            轮询间隔
          </h3>
          <p className="text-sm text-gray-500 mt-1 ml-7">
            系统检查所有监控商品价格的频率。建议不要设置过短，以免触发频繁访问限制。
          </p>
        </div>
        <div className="p-6">
          <div className="max-w-xs">
            <label className="block text-sm font-medium text-gray-700 mb-2">检查周期</label>
            <div className="relative">
              <input
                type="number"
                min="10"
                value={config.pollingInterval}
                onChange={(e) => updateConfig({ pollingInterval: Math.max(10, parseInt(e.target.value) || 10) })}
                className="w-full pl-4 pr-12 py-2.5 border border-gray-200 rounded-xl focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition-all"
              />
              <span className="absolute right-4 top-2.5 text-gray-400 text-sm">分钟</span>
            </div>
            <p className="text-xs text-gray-400 mt-2">最小值：10 分钟</p>
          </div>
        </div>
      </section>

      {/* Save Action Bar */}
      <div className="sticky bottom-20 md:bottom-4 bg-white/80 backdrop-blur-md border border-gray-200 p-4 rounded-2xl shadow-lg flex justify-between items-center">
        <div className="text-sm text-gray-500 pl-2">
          {saveStatus === 'saved' ? (
            <span className="flex items-center gap-2 text-green-600 font-medium">
              <CheckCircle2 className="w-4 h-4" /> 设置已保存
            </span>
          ) : (
            <span>修改后请记得保存</span>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving' || hasValidationError}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-white transition-all ${
            saveStatus === 'saved'
              ? 'bg-green-500'
              : 'bg-gray-900 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed'
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
