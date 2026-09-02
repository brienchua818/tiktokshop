import { withAuth, json } from '../lib/http'

/** Who is signed in. The browser cannot read the session cookie, so it asks. */
export default withAuth(async (_request, { user }) =>
  json({ email: user.email, name: user.name, picture: user.picture }),
)
