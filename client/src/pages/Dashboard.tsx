import React, { useEffect, useState } from 'react';
import { Plus, TrendingDown, Package, Users } from 'lucide-react';
import { api } from '../services/api';
import { Product, SystemStatus } from '../types';
import ProductCard from '../components/ProductCard';
import AddProductModal from '../components/AddProductModal';

export default function Dashboard() {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [productsData, statusData] = await Promise.all([
        api.getProducts(),
        api.getSystemStatus(),
      ]);
      setProducts(productsData);
      setStatus(statusData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddProduct = async (input: string) => {
    await api.addProduct(input);
    await loadData();
  };

  const handleRefresh = async (id: string) => {
    try {
      await api.refreshProduct(id);
      // 更新本地状态显示刷新中
      setProducts((prev) =>
        prev.map((p) => (p.id === id ? { ...p, lastError: null } : p))
      );
    } catch (error) {
      console.error('Failed to refresh product:', error);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要停止监控这个商品吗？')) return;
    try {
      await api.deleteProduct(id);
      setProducts((prev) => prev.filter((p) => p.id !== id));
    } catch (error) {
      console.error('Failed to delete product:', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">监控面板</h2>
          <p className="text-gray-500 text-sm mt-1">
            正在监控 <span className="font-bold text-orange-600">{products.length}</span> 个商品
          </p>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full sm:w-auto bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-gray-200"
        >
          <Plus className="w-4 h-4" />
          添加商品
        </button>
      </div>

      {/* Stats Cards */}
      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <Package className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{status.stats.activeProducts}</p>
                <p className="text-xs text-gray-500">监控商品</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Users className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{status.stats.activeAccounts}</p>
                <p className="text-xs text-gray-500">活跃账号</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <TrendingDown className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{status.stats.todaySnapshots}</p>
                <p className="text-xs text-gray-500">今日抓取</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
              </div>
              <div>
                <p className="text-sm font-bold text-green-600">运行中</p>
                <p className="text-xs text-gray-500">系统状态</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="flex flex-col gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 bg-gray-100 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onRefresh={handleRefresh}
              onDelete={handleDelete}
            />
          ))}
          {products.length === 0 && (
            <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-gray-300">
              <p className="text-gray-400 mb-4">还没有监控任何商品</p>
              <button
                onClick={() => setIsModalOpen(true)}
                className="text-orange-600 font-bold text-sm hover:underline"
              >
                添加第一个商品
              </button>
            </div>
          )}
        </div>
      )}

      <AddProductModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleAddProduct}
      />
    </div>
  );
}
