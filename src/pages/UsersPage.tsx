import { Search, UserPlus } from 'lucide-react'
import { DataAuthority } from '@/components/DataAuthority'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { UserStateBadge } from '@/components/TempPasswordDialog'
import { ErrorBox, LoadingRows, PageHeader, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { formatDateTime, ROLE_LABEL } from '@/lib/format'
import type { AppRole } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'
import { ROLE_ORDER, userState, type UserState } from '@/lib/users'

export function UsersPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<'current' | UserState | 'all'>('current')
  const [role, setRole] = useState<AppRole | ''>('')

  const { data, error, loading } = useAsync(async () => {
    const [users, departments] = await Promise.all([api.users(), api.departments()])
    return { users, dept: new Map(departments.map((d) => [d.id, d.name])) }
  })

  const rows = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.users.filter((u) => {
      const state = userState(u)
      if (show === 'current' && state === 'deactivated') return false
      if (show !== 'current' && show !== 'all' && state !== show) return false
      if (role && !u.roles.includes(role)) return false
      if (!q) return true
      return [u.full_name, u.email, u.job_title, data.dept.get(u.department_id ?? '')].some((v) => v?.toLowerCase().includes(q))
    })
  }, [data, query, show, role])

  const counts = useMemo(() => {
    const users = data?.users ?? []
    return {
      active: users.filter((u) => u.is_active).length,
      waiting: users.filter((u) => userState(u) === 'waiting').length,
      deactivated: users.filter((u) => !u.is_active).length,
    }
  }, [data])

  const deptNames = (ids: string[]) => ids.map((id) => data?.dept.get(id) ?? '?').sort().join(', ')

  return (
    <div className="space-y-5">
      <PageHeader title="Users"
        subtitle={data ? `${counts.active} active · ${counts.waiting} yet to sign in · ${counts.deactivated} deactivated` : 'Who can use Agent Control Tower, and what they can do.'}
        actions={<Button asChild><Link to="/users/new"><UserPlus /> Add person</Link></Button>} />

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" aria-hidden />
          <Input className="pl-8" placeholder="Search name, email, job title or department" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search users" />
        </div>
        <select className={`${selectClass} sm:w-48`} value={role} onChange={(e) => setRole(e.target.value as AppRole | '')} aria-label="Role">
          <option value="">Any role</option>
          {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <select className={`${selectClass} sm:w-48`} value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label="Show">
          <option value="current">Active and invited</option>
          <option value="waiting">Yet to sign in</option>
          <option value="deactivated">Deactivated</option>
          <option value="all">Everyone</option>
        </select>
      </div>

      <ErrorBox message={error} />
      {loading && !data && <LoadingRows />}

      {data && (
        <>
          {/* Desktop */}
          <div className="hidden overflow-hidden rounded-lg border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-left text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 font-medium">Roles</th>
                  <th className="px-3 py-2 font-medium">Approves for</th>
                  <th className="px-3 py-2 font-medium">Last sign-in</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((u) => (
                  <tr key={u.id} className="hover:bg-muted/40 cursor-pointer" onClick={() => navigate(`/users/${u.id}`)}>
                    <td className="px-3 py-2.5">
                      <Link to={`/users/${u.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {u.full_name}
                      </Link>
                      <div className="text-muted-foreground text-xs">{u.email}{u.job_title ? ` · ${u.job_title}` : ''}</div>
                    </td>
                    <td className="px-3 py-2.5"><RolePills roles={u.roles} /></td>
                    <td className="text-muted-foreground px-3 py-2.5 text-xs">{u.roles.includes('approver') ? deptNames(u.scope_department_ids) : '—'}</td>
                    <td className="text-muted-foreground px-3 py-2.5 text-xs whitespace-nowrap">
                      {u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : 'Never'}
                    </td>
                    <td className="px-3 py-2.5"><UserStateBadge state={userState(u)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone */}
          <ul className="divide-y rounded-lg border md:hidden">
            {rows.map((u) => (
              <li key={u.id}>
                <Link to={`/users/${u.id}`} className="block space-y-1.5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{u.full_name}</div>
                      <div className="text-muted-foreground truncate text-xs">{u.email}</div>
                    </div>
                    <UserStateBadge state={userState(u)} />
                  </div>
                  <RolePills roles={u.roles} />
                </Link>
              </li>
            ))}
          </ul>

          {rows.length === 0 && <p className="text-muted-foreground py-6 text-center text-sm">No one matches these filters.</p>}
        </>
      )}
      {/* Task 4.8 */}
      <div className="border-t pt-6"><DataAuthority /></div>
    </div>
  )
}

function RolePills({ roles }: { roles: AppRole[] }) {
  if (!roles.length) return <span className="text-xs text-red-700 dark:text-red-400">No role</span>
  return (
    <div className="flex flex-wrap gap-1">
      {ROLE_ORDER.filter((r) => roles.includes(r)).map((r) => (
        <span key={r} className={r === 'admin'
          ? 'bg-brand-charcoal rounded-md px-2 py-0.5 text-xs text-white dark:bg-white dark:text-black'
          : 'bg-secondary rounded-md px-2 py-0.5 text-xs'}>{ROLE_LABEL[r]}</span>
      ))}
    </div>
  )
}
