/* One tool failing must not take the whole app (and the other open tabs) down
   with it: the error stays in its pane, is logged to the journal, and the pane
   can be reset without losing the session. */

import { Component, ReactNode } from 'react';
import { log } from '../lib/log';
import { plain, translate } from '../i18n/core';
import { COMMON } from '../i18n/common';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class PaneBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error) { log.error(error.message); console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    const t = (k: string) => plain(translate(COMMON, k));
    return (
      <div className="pane-error s-card">
        <h2>{t('err.title')}</h2>
        <p>{t('err.body')}</p>
        <pre>{this.state.error.message}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>{t('err.retry')}</button>
      </div>
    );
  }
}
