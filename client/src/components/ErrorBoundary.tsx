import React from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  /** 顯示在錯誤畫面上的區塊名稱，例如「報價單列表」 */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * 錯誤邊界。
 *
 * 問題背景：任何一筆結構不完整的舊資料（例如缺 `lineItems` 的報價單）
 * 在 render 期間拋錯，整個 React 樹就會被卸載 —— 使用者看到的是**全白畫面**，
 * 沒有任何訊息，也沒有任何可以按的東西，只能自己想到要重新整理。
 *
 * 有了這個邊界，至少會顯示發生什麼事、可以重試或回到列表，
 * 而且錯誤詳情看得到（方便回報問題）。
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] 畫面發生未預期錯誤:', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="max-w-2xl mx-auto my-12 p-6 border border-red-200 rounded-lg bg-red-50">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-red-800">
              {this.props.label ? `${this.props.label}發生錯誤` : '頁面發生錯誤'}
            </h2>
            <p className="text-sm text-red-700 mt-1">
              這通常是因為某一筆資料的格式不完整。你的資料沒有遺失，可以先返回列表再試一次。
            </p>

            <pre className="mt-3 p-2 bg-white/70 border border-red-200 rounded text-xs text-red-900 overflow-auto max-h-40 whitespace-pre-wrap">
              {error.message || String(error)}
            </pre>

            <div className="flex gap-2 mt-4">
              <Button
                onClick={this.handleRetry}
                className="bg-red-600 hover:bg-red-700 text-white"
                data-testid="button-error-retry"
              >
                重試
              </Button>
              <Button
                variant="outline"
                onClick={() => { window.location.href = '/list'; }}
                data-testid="button-error-back"
              >
                返回報價單列表
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
