import React from 'react';
import { Users, UserPlus, MoreVertical, Shield } from 'lucide-react';

const mockUsers = [
  { id: '1', name: 'Admin User', email: 'admin@auragold.com', role: 'Admin', status: 'Active', lastLogin: '2 mins ago' },
  { id: '2', name: 'John Trader', email: 'john@example.com', role: 'Client', status: 'Active', lastLogin: '1 hour ago' },
  { id: '3', name: 'Sarah Wealth', email: 'sarah@example.com', role: 'Client', status: 'Inactive', lastLogin: '5 days ago' },
];

export default function Admin() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">User Management</h2>
          <p className="text-slate-500 text-sm mt-1 font-medium">Manage administrators and client access</p>
        </div>
        <button className="flex items-center gap-2 bg-gold-500 hover:bg-gold-600 text-white font-bold py-2.5 px-5 rounded-xl shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
          <UserPlus size={18} /> Add User
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-card p-6 flex items-center gap-5">
          <div className="p-3.5 bg-blue-50 rounded-xl border border-blue-100 shadow-sm">
            <Users size={24} className="text-blue-600" />
          </div>
          <div>
            <p className="text-slate-500 text-sm font-semibold uppercase tracking-wider mb-1">Total Users</p>
            <h3 className="text-3xl font-bold text-slate-900 tracking-tight">124</h3>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-card p-6 flex items-center gap-5">
          <div className="p-3.5 bg-emerald-50 rounded-xl border border-emerald-100 shadow-sm">
            <Shield size={24} className="text-emerald-600" />
          </div>
          <div>
            <p className="text-slate-500 text-sm font-semibold uppercase tracking-wider mb-1">Active Clients</p>
            <h3 className="text-3xl font-bold text-slate-900 tracking-tight">118</h3>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider">
                <th className="p-5 font-bold">User</th>
                <th className="p-5 font-bold">Role</th>
                <th className="p-5 font-bold">Status</th>
                <th className="p-5 font-bold">Last Login</th>
                <th className="p-5 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {mockUsers.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="p-5">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-sm font-bold text-slate-700 shadow-sm">
                        {user.name.charAt(0)}
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">{user.name}</div>
                        <div className="text-xs font-medium text-slate-500 mt-0.5">{user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-5">
                    <span className={`px-2.5 py-1 rounded-md text-xs font-bold border ${
                      user.role === 'Admin' ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-slate-100 text-slate-600 border-slate-200'
                    }`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="p-5">
                    <span className={`flex items-center gap-2 text-sm font-semibold ${
                      user.status === 'Active' ? 'text-emerald-600' : 'text-slate-500'
                    }`}>
                      <div className={`w-2 h-2 rounded-full ${user.status === 'Active' ? 'bg-emerald-500' : 'bg-slate-400'}`}></div>
                      {user.status}
                    </span>
                  </td>
                  <td className="p-5 text-sm font-medium text-slate-500">{user.lastLogin}</td>
                  <td className="p-5 text-right">
                    <button className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                      <MoreVertical size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}