import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Bell, Settings, ShoppingBag } from 'lucide-react';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const navItems = [
    { to: '/', icon: LayoutDashboard, label: '监控面板' },
    { to: '/accounts', icon: Users, label: '账号管理' },
    { to: '/notifications', icon: Bell, label: '通知设置' },
    { to: '/settings', icon: Settings, label: '系统设置' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans pb-20 md:pb-0">
      {/* Desktop Sidebar / Mobile Header */}
      <header className="fixed top-0 left-0 right-0 h-16 bg-white border-b border-gray-200 z-30 flex items-center px-4 md:px-6 justify-between md:justify-start md:gap-4">
        <div className="flex items-center gap-2">
          <div className="bg-orange-500 p-2 rounded-lg">
            <ShoppingBag className="w-5 h-5 text-white" />
          </div>
          <h1 className="font-bold text-xl tracking-tight hidden md:block">淘宝价格监控</h1>
          <h1 className="font-bold text-xl tracking-tight md:hidden">价格监控</h1>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="pt-20 px-4 md:px-8 max-w-6xl mx-auto md:ml-64 transition-all pb-6">
        {children}
      </main>

      {/* Desktop Sidebar Navigation */}
      <aside className="fixed left-0 top-16 bottom-0 w-64 bg-white border-r border-gray-200 hidden md:flex flex-col py-6 px-4 z-20">
        <nav className="space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-colors ${
                  isActive
                    ? 'bg-orange-50 text-orange-600'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`
              }
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 md:hidden z-30 safe-area-inset-bottom">
        <div className="flex justify-around items-center h-16">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center w-full h-full space-y-1 ${
                  isActive ? 'text-orange-600' : 'text-gray-400'
                }`
              }
            >
              <item.icon className="w-6 h-6" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
