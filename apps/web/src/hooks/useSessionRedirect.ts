import { useWorkspaces } from '@/hooks/useWorkspaces'
import { useEffect } from 'react'
import { NextRouter, useRouter } from 'next/router'
import { useSession, useSignout } from '@/hooks/useAuth'
import useProperties from './useProperties'

const redirectToLogin = (router: NextRouter) => {
  const postRedirPath = router.asPath
  const path =
    postRedirPath === '/'
      ? '/auth/signin'
      : `/auth/signin?r=${encodeURIComponent(postRedirPath)}`

  router.replace(path)
}

export const useSessionRedirect = (shouldRedirect = true) => {
  const properties = useProperties()
  const router = useRouter()
  const session = useSession()
  const [workspaces] = useWorkspaces()
  const signOut = useSignout()

  useEffect(() => {
    if (
      !shouldRedirect ||
      session.isLoading ||
      workspaces.isLoading ||
      properties.isLoading ||
      !properties.data
    ) {
      return
    }

    if (!session.data) {
      if (properties.data.needsSetup) {
        router.replace('/setup')
      } else {
        redirectToLogin(router)
      }
    } else {
      const user = session.data
      const workspace =
        workspaces.data.find(
          (workspace) => workspace.id === user.lastVisitedWorkspaceId
        ) ??
        workspaces.data.find((workspace) => workspace.ownerId === user.id) ??
        workspaces.data[0]
      if (workspace) {
        router.replace(`/workspaces/${workspace.id}/documents`)
      } else {
        signOut()
      }
    }
  }, [properties, workspaces, session, router, shouldRedirect, signOut])
}
