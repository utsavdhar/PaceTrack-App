import React, { useState, useEffect } from 'react';
import { auth, db } from './firebase';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';

function App() {
  // --- Splash Screen & Core Theme Configuration ---
  const [showSplash, setShowSplash] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem('pt-theme') || 'dark');

  // --- Auth States ---
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => localStorage.getItem('pt-remember') === 'true');
  const [isRegistering, setIsRegistering] = useState(false);

  // --- Form Input States ---
  const [trackerName, setTrackerName] = useState('');
  const [timelineType, setTimelineType] = useState('monthly'); // weekly, monthly, yearly, multi-year, expense-control
  const [customYears, setCustomYears] = useState('2'); 
  const [startPeriod, setStartPeriod] = useState(() => {
    const today = new Date();
    return today.toISOString().split('T')[0]; 
  });
  const [targetAmount, setTargetAmount] = useState('');
  const [incomeBase, setIncomeBase] = useState('');

  // --- Master App Storage State ---
  const [trackers, setTrackers] = useState([]);

  // --- Splash Dismiss Timer ---
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 1600); // Fast, high-end professional splash window duration
    return () => clearTimeout(timer);
  }, []);

  // --- Sync Theme ---
  useEffect(() => {
    localStorage.setItem('pt-theme', theme);
  }, [theme]);

  // --- Sync Remember Me state ---
  useEffect(() => {
    localStorage.setItem('pt-remember', rememberMe ? 'true' : 'false');
  }, [rememberMe]);

  // --- Auth Listener ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
      // Pre-fill email safely if remember me was flagged true in a past layout
      if (currentUser === null && localStorage.getItem('pt-remember') === 'true') {
        const savedEmail = localStorage.getItem('pt-saved-email');
        if (savedEmail) setEmail(savedEmail);
      }
    });
    return unsubscribe;
  }, []);

  // --- Cloud Snapshot Sync ---
  useEffect(() => {
    if (!user) {
      setTrackers([]);
      return;
    }
    const userDocRef = doc(db, "users", user.uid);
    const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
      if (docSnap.exists() && docSnap.data().trackers) {
        setTrackers(docSnap.data().trackers);
      } else {
        setTrackers([]);
      }
    });
    return unsubscribe;
  }, [user]);

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      
      if (rememberMe) {
        localStorage.setItem('pt-saved-email', email);
      } else {
        localStorage.removeItem('pt-saved-email');
      }
      
      setPassword('');
      setShowPassword(false);
    } catch (error) {
      alert(error.message);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      if (!rememberMe) {
        setEmail('');
      }
    } catch (error) {
      console.error("Sign out misconfiguration:", error);
    }
  };

  const saveTrackersToCloud = async (updatedList) => {
    if (!user) return;
    try {
      await setDoc(doc(db, "users", user.uid), { trackers: updatedList }, { merge: true });
    } catch (error) {
      console.error("Cloud synchronization mismatch:", error);
    }
  };

  const calculatePaceMetrics = (type, goalVal, yearsCount) => {
    const totalGoal = parseFloat(goalVal) || 0;
    if (totalGoal <= 0) return { divisorLabel: 'period', microTarget: 0 };

    switch(type) {
      case 'expense-control':
        return { divisorLabel: 'month pool', microTarget: totalGoal };
      case 'weekly':
        return { divisorLabel: 'week', microTarget: totalGoal };
      case 'monthly':
        return { divisorLabel: 'month', microTarget: totalGoal };
      case 'yearly':
        return { divisorLabel: 'month', microTarget: parseFloat((totalGoal / 12).toFixed(0)) };
      case 'multi-year':
        const totalMonths = (parseInt(yearsCount) || 2) * 12;
        return { divisorLabel: 'month', microTarget: parseFloat((totalGoal / totalMonths).toFixed(0)) };
      default:
        return { divisorLabel: 'period', microTarget: totalGoal };
    }
  };

  const handleCreateTracker = (e) => {
    e.preventDefault();
    if (!trackerName || !targetAmount) return;

    const goalVal = parseFloat(targetAmount);
    const { divisorLabel, microTarget } = calculatePaceMetrics(timelineType, goalVal, customYears);
    const startingBalance = timelineType === 'expense-control' ? goalVal : 0;

    const newTracker = {
      id: Date.now().toString(),
      name: trackerName,
      type: timelineType,
      yearsScale: timelineType === 'multi-year' ? parseInt(customYears) : 1,
      startPeriod: startPeriod,
      totalGoal: goalVal,
      incomeBase: parseFloat(incomeBase) || 0,
      microTarget: microTarget,
      targetPeriodLabel: divisorLabel,
      savingsBalance: startingBalance, 
      currentMilestoneSaved: startingBalance, 
      transactions: []   
    };

    const updated = [...trackers, newTracker];
    setTrackers(updated);
    saveTrackersToCloud(updated);
    
    setTrackerName('');
    setTargetAmount('');
    setIncomeBase('');
  };

  const recalculateTrackerBalances = (tracker) => {
    const isExpenseMode = tracker.type === 'expense-control';
    const baseBalance = isExpenseMode ? tracker.totalGoal : 0;
    
    let currentBalance = baseBalance;
    let currentMilestone = baseBalance;

    const reversedTx = [...tracker.transactions].reverse();
    
    reversedTx.forEach((tx) => {
      let balanceChange = 0;
      if (isExpenseMode) {
        if (tx.type === 'settlement') {
          currentBalance = tracker.totalGoal;
          currentMilestone = tracker.totalGoal;
          return;
        }
        balanceChange = tx.type === 'expense' ? -tx.amount : tx.amount;
      } else {
        if (tx.type === 'settlement') {
          currentBalance = 0;
          currentMilestone = 0;
          return;
        }
        balanceChange = tx.type === 'deposit' ? tx.amount : -tx.amount;
      }
      
      currentBalance += balanceChange;
      if (isExpenseMode) {
        currentMilestone = currentBalance;
      } else {
        currentMilestone = Math.max(0, currentMilestone + balanceChange);
      }
    });

    return {
      ...tracker,
      savingsBalance: currentBalance,
      currentMilestoneSaved: currentMilestone
    };
  };

  const handleLogTransaction = (trackerId, type, amountValue, reasonText) => {
    const numAmount = parseFloat(amountValue);
    if (isNaN(numAmount) || numAmount <= 0) return;

    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const newTx = {
          id: Date.now().toString(),
          type: type,
          amount: numAmount,
          reason: reasonText || (type === 'deposit' ? 'Added funds' : 'Logged expense'),
          date: new Date().toLocaleDateString('en-BD', { month: 'short', day: 'numeric' })
        };
        const updatedTrack = {
          ...track,
          transactions: [newTx, ...(track.transactions || [])]
        };
        return recalculateTrackerBalances(updatedTrack);
      }
      return track;
    });

    setTrackers(updated);
    saveTrackCloud(updated);
  };

  const handleEditTransaction = (trackerId, transactionId, newAmount, newReason) => {
    const numAmount = parseFloat(newAmount);
    if (isNaN(numAmount) || numAmount <= 0) return;

    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const updatedTxList = track.transactions.map((tx) => {
          if (tx.id === transactionId) {
            return { ...tx, amount: numAmount, reason: newReason };
          }
          return tx;
        });
        return recalculateTrackerBalances({ ...track, transactions: updatedTxList });
      }
      return track;
    });

    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const handleDeleteTransaction = (trackerId, transactionId) => {
    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const updatedTxList = track.transactions.filter((tx) => tx.id !== transactionId);
        return recalculateTrackerBalances({ ...track, transactions: updatedTxList });
      }
      return track;
    });

    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const handleDeleteTracker = (trackerId) => {
    if (!window.confirm("Are you sure you want to completely remove this tracker?")) return;
    const updated = trackers.filter((t) => t.id !== trackerId);
    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const handleSettleMilestone = (trackerId) => {
    const updated = trackers.map((track) => {
      if (track.id === trackerId) {
        const isExpenseMode = track.type === 'expense-control';
        const updatedTrack = {
          ...track,
          transactions: [{
            id: Date.now().toString(),
            type: 'settlement',
            amount: isExpenseMode ? track.savingsBalance : (track.microTarget || 0),
            reason: isExpenseMode ? `🔄 Monthly budget rolled over & renewed` : `🎉 Period goals completed`,
            date: new Date().toLocaleDateString('en-BD', { month: 'short', day: 'numeric' })
          }, ...(track.transactions || [])]
        };
        return recalculateTrackerBalances(updatedTrack);
      }
      return track;
    });
    setTrackers(updated);
    saveTrackersToCloud(updated);
  };

  const currentPreview = calculatePaceMetrics(timelineType, targetAmount, customYears);
  const incomeNum = parseFloat(incomeBase) || 0;
  const incomePercentage = incomeNum > 0 ? ((currentPreview.microTarget / incomeNum) * 100).toFixed(1) : 0;

  // --- 1. Dynamic Splash Screen Overlay ---
  if (showSplash) {
    return (
      <div className="fixed inset-0 bg-zinc-950 flex flex-col items-center justify-center z-50 transition-opacity duration-500 ease-out animate-fadeIn">
        <div className="relative flex flex-col items-center space-y-4">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 p-0.5 flex items-center justify-center shadow-xl shadow-emerald-950/40 animate-scaleUp">
            <div className="h-full w-full bg-zinc-900 rounded-[14px] flex items-center justify-center">
              <span className="text-2xl">⚡</span>
            </div>
          </div>
          <div className="text-center space-y-1">
            <h1 className="text-3xl font-black tracking-tight text-white font-sans">PaceTrack</h1>
            <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Financial Velocity Workspace</p>
          </div>
        </div>
      </div>
    );
  }

  // --- 2. Auth Loading Spinner ---
  if (authLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${theme === 'dark' ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
        <div className={`h-6 w-6 rounded-full border-2 border-transparent animate-spin ${theme === 'dark' ? 'border-t-white' : 'border-t-zinc-900'}`}></div>
      </div>
    );
  }

  return (
    /* Dynamic status safe margin padding block to match hardware notch viewports perfectly */
    <div className={`min-h-screen transition-colors duration-300 antialiased flex flex-col items-center pt-[env(safe-area-inset-top,24px)] pb-10 px-4 sm:px-6 w-full ${
      theme === 'dark' ? 'bg-zinc-950 text-zinc-100 selection:bg-emerald-500/20' : 'bg-zinc-50 text-zinc-900 selection:bg-emerald-500/10'
    }`}>
      
      {!user ? (
        <div className="w-full max-w-sm my-auto space-y-6 animate-fadeIn">
          <div className="text-center space-y-1">
            <h1 className={`text-3xl font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>PaceTrack</h1>
            <p className={`text-xs font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Track your finances cleanly</p>
          </div>

          <form onSubmit={handleAuth} className={`border p-6 rounded-2xl shadow-2xl space-y-5 backdrop-blur-md transition-all duration-300 ${
            theme === 'dark' ? 'bg-zinc-900/40 border-zinc-900' : 'bg-white border-zinc-200'
          }`}>
            <h2 className={`text-xs font-bold tracking-widest uppercase ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-500'}`}>
              {isRegistering ? 'Create your account' : 'Welcome back'}
            </h2>

            <div className="space-y-4">
              <div>
                <label htmlFor="email" className={`block text-xs font-bold uppercase tracking-wider mb-1 px-0.5 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Email Address</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="Your email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`w-full border rounded-xl px-4 py-3 text-base focus:outline-none transition-all font-medium ${
                    theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-600 placeholder:text-zinc-600' : 'bg-zinc-100/80 border-zinc-300 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                  }`}
                  required
                />
              </div>
              
              <div>
                <label htmlFor="password" className={`block text-xs font-bold uppercase tracking-wider mb-1 px-0.5 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Password</label>
                <div className="relative w-full">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Secure password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`w-full border rounded-xl pl-4 pr-11 py-3 text-base focus:outline-none transition-all font-medium ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-600 placeholder:text-zinc-600' : 'bg-zinc-100/80 border-zinc-300 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                    }`}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className={`absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-sm rounded-lg hover:bg-zinc-500/10 transition-colors ${
                      theme === 'dark' ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-700'
                    }`}
                    title={showPassword ? "Hide Password" : "Show Password"}
                  >
                    {showPassword ? "👁️" : "🙈"}
                  </button>
                </div>
              </div>

              {/* Remember Me Core Interaction Row */}
              <div className="flex items-center justify-between pt-0.5 px-0.5">
                <label className="flex items-center space-x-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-zinc-300 text-emerald-500 accent-emerald-500 bg-zinc-100 dark:bg-zinc-900 focus:ring-0 cursor-pointer transition-all"
                  />
                  <span className={`text-xs font-semibold select-none transition-colors ${theme === 'dark' ? 'text-zinc-400 group-hover:text-zinc-300' : 'text-zinc-600 group-hover:text-zinc-950'}`}>
                    Remember me
                  </span>
                </label>
              </div>
            </div>

            <button
              type="submit"
              className={`w-full font-bold py-3.5 rounded-xl text-xs transition-all tracking-wide active:scale-[0.98] hover:opacity-90 shadow-md ${
                theme === 'dark' ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-zinc-950 hover:bg-zinc-800 text-white'
              }`}
            >
              {isRegistering ? 'Register account' : 'Sign in to dashboard'}
            </button>

            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => {
                  setIsRegistering(!isRegistering);
                  setShowPassword(false);
                }}
                className={`text-xs transition-colors font-semibold underline underline-offset-4 ${theme === 'dark' ? 'text-zinc-400 hover:text-zinc-300' : 'text-zinc-600 hover:text-zinc-950'}`}
              >
                {isRegistering ? 'Have an account? Log in' : "Don't have an account? Sign up"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="w-full max-w-md space-y-6 animate-fadeIn">
          
          <header className={`w-full flex justify-between items-center py-5 border-b transition-all ${
            theme === 'dark' ? 'border-zinc-900' : 'border-zinc-200'
          }`}>
            <div>
              <h1 className={`text-2xl font-black tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>PaceTrack</h1>
              <span className={`text-xs font-mono flex items-center gap-1 mt-1 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>
                <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]"></span>
                {user.email}
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className={`px-2 sm:px-3 py-2 rounded-xl border text-xs font-bold transition-all active:scale-90 flex items-center justify-center gap-1 shrink-0 ${
                  theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800 text-zinc-300 hover:text-white' : 'bg-white border-zinc-300 text-zinc-700 hover:text-zinc-950'
                }`}
              >
                <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
                <span className="whitespace-nowrap">{theme === 'dark' ? 'Light' : 'Dark'}</span>
              </button>
              
              <button 
                onClick={handleSignOut}
                className={`text-xs uppercase font-bold tracking-widest border px-3 py-2 rounded-xl transition-all active:scale-95 ${
                  theme === 'dark' ? 'bg-zinc-900/20 border-zinc-800 text-zinc-400 hover:text-rose-400 hover:border-rose-950' : 'bg-white border-zinc-300 text-zinc-600 hover:text-rose-600 hover:border-rose-300'
                }`}
              >
                Exit
              </button>
            </div>
          </header>

          <form onSubmit={handleCreateTracker} className={`border p-5 rounded-2xl shadow-xl space-y-4 transition-all ${
            theme === 'dark' ? 'bg-zinc-900/40 border-zinc-900' : 'bg-white border-zinc-200 shadow-zinc-200/60'
          }`}>
            <h2 className={`text-xs font-bold tracking-widest uppercase ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-500'}`}>Set up your tracker</h2>
            
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Goal name (e.g., Household Savings, New Laptop)"
                value={trackerName}
                onChange={(e) => setTrackerName(e.target.value)}
                className={`w-full border rounded-xl px-4 py-3 text-base focus:outline-none transition-all font-medium ${
                  theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-600 placeholder:text-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                }`}
                required
              />

              <div>
                <label className={`block text-xs font-bold uppercase tracking-widest mb-1.5 px-0.5 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Tracking schedule</label>
                <div className={`grid grid-cols-3 gap-1 p-1 rounded-xl border ${
                  theme === 'dark' ? 'bg-zinc-900/80 border-zinc-800/60' : 'bg-zinc-100 border-zinc-300'
                }`}>
                  {['weekly', 'monthly', 'yearly', 'multi-year', 'expense-control'].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setTimelineType(mode)}
                      className={`py-2 text-[10px] sm:text-xs font-bold rounded-lg transition-all text-center ${
                        timelineType === mode 
                          ? (theme === 'dark' ? 'bg-zinc-800 text-white shadow-sm font-black' : 'bg-white text-zinc-950 shadow-sm font-black') 
                          : (theme === 'dark' ? 'text-zinc-400 hover:text-zinc-300' : 'text-zinc-600 hover:text-zinc-900')
                      }`}
                    >
                      {mode === 'expense-control' ? 'expense' : mode.replace('-', ' ')}
                    </button>
                  ))}
                </div>
              </div>

              {timelineType === 'multi-year' && (
                <div className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 animate-fadeIn ${theme === 'dark' ? 'bg-black/10 border-zinc-800' : 'bg-zinc-100 border-zinc-200'}`}>
                  <div>
                    <label className={`block text-xs font-bold uppercase tracking-widest ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Time scale</label>
                    <span className={`text-xs font-medium ${theme === 'dark' ? 'text-zinc-500' : 'text-zinc-600'}`}>Set tracking duration up to 10 years.</span>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <input 
                      type="range" min="2" max="10" 
                      value={customYears} 
                      onChange={(e) => setCustomYears(e.target.value)}
                      className="accent-emerald-500 w-24 cursor-pointer"
                    />
                    <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${theme === 'dark' ? 'bg-zinc-800 text-white' : 'bg-zinc-200 text-zinc-900'}`}>{customYears} years</span>
                  </div>
                </div>
              )}

              {/* Form Input Layout Overlap Corrections */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-widest mb-1 px-0.5 whitespace-nowrap text-zinc-400 dark:text-zinc-400">Start date</label>
                  <input
                    type="date"
                    value={startPeriod}
                    onChange={(e) => setStartPeriod(e.target.value)}
                    className={`w-full border rounded-xl px-3 py-2.5 text-base focus:outline-none font-mono ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 focus:border-zinc-400'
                    }`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-widest mb-1 px-0.5 whitespace-nowrap text-zinc-400 dark:text-zinc-400">
                    {timelineType === 'expense-control' ? 'Monthly Budget' : 'Savings Target'}
                  </label>
                  <input
                    type="number"
                    placeholder={timelineType === 'expense-control' ? 'e.g., 40000' : 'e.g., 500000'}
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(e.target.value)}
                    className={`w-full border rounded-xl px-3 py-2.5 text-base focus:outline-none font-mono ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-600 placeholder:text-zinc-700' : 'bg-zinc-50 border-zinc-300 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                    }`}
                    required
                  />
                </div>
              </div>

              {timelineType !== 'expense-control' && (
                <div className="space-y-1">
                  <label className={`block text-xs font-bold uppercase tracking-widest px-0.5 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Monthly salary or income (Optional)</label>
                  <input
                    type="number"
                    placeholder="e.g., 50000 BDT"
                    value={incomeBase}
                    onChange={(e) => setIncomeBase(e.target.value)}
                    className={`w-full border rounded-xl px-4 py-3 text-base focus:outline-none transition-all font-mono ${
                      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 text-white focus:border-zinc-600 placeholder:text-zinc-700' : 'bg-zinc-50 border-zinc-300 text-zinc-900 focus:border-zinc-400 placeholder:text-zinc-400'
                    }`}
                  />
                </div>
              )}

              <button
                type="submit"
                className={`w-full font-bold py-3.5 rounded-xl text-xs transition-all tracking-wide active:scale-[0.98] hover:opacity-90 shadow-md ${
                  theme === 'dark' ? 'bg-white hover:bg-zinc-200 text-black' : 'bg-zinc-950 hover:bg-zinc-800 text-white'
                }`}
              >
                Create budget plan
              </button>
            </div>
          </form>

          {targetAmount > 0 && timelineType !== 'expense-control' && (
            <div className={`border p-4 rounded-xl flex justify-between items-center animate-fadeIn ${
              theme === 'dark' ? 'bg-zinc-900/20 border-dashed border-zinc-800/80' : 'bg-zinc-100/50 border-dashed border-zinc-300'
            }`}>
              <div>
                <div className={`text-xs font-bold uppercase tracking-widest ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Required breakdown goal</div>
                <div className={`text-lg font-black font-mono ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>
                  {parseInt(currentPreview.microTarget).toLocaleString()} BDT
                  <span className={`text-xs font-normal ${theme === 'dark' ? 'text-zinc-500' : 'text-zinc-500'}`}>/{currentPreview.divisorLabel}</span>
                </div>
              </div>
              {incomeNum > 0 && (
                <div className="text-right">
                  <div className={`text-xs font-bold uppercase tracking-widest ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Budget strain</div>
                  <div className="text-sm font-bold text-emerald-500 font-mono">{incomePercentage}%</div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="flex justify-between items-center px-0.5">
              <h2 className={`text-xs font-bold uppercase tracking-widest ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Active budgets</h2>
              <span className={`text-xs font-mono font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>Total trackers: {trackers.length}</span>
            </div>
            
            {trackers.length === 0 ? (
              <div className={`text-center py-10 border border-dashed rounded-2xl ${
                theme === 'dark' ? 'bg-zinc-900/10 border-zinc-800' : 'bg-zinc-100/20 border-zinc-300'
              }`}>
                <p className={`text-xs tracking-wide px-4 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>No active tracking schedules. Create your first one above!</p>
              </div>
            ) : (
              <div className="space-y-5">
                {trackers.map((item) => (
                  <ActiveTrackerCard 
                    key={item.id} 
                    tracker={item} 
                    theme={theme}
                    onLog={handleLogTransaction} 
                    onEditTx={handleEditTransaction}
                    onDeleteTx={handleDeleteTransaction}
                    onDeleteTracker={handleDeleteTracker}
                    onSettle={handleSettleMilestone}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveTrackerCard({ tracker, theme, onLog, onEditTx, onDeleteTx, onDeleteTracker, onSettle }) {
  const [logAmount, setLogAmount] = useState('');
  const [logReason, setLogReason] = useState('');
  
  const [editingTxId, setEditingTxId] = useState(null);
  const [editAmount, setEditAmount] = useState('');
  const [editReason, setEditReason] = useState('');

  const isExpenseMode = tracker.type === 'expense-control';
  const totalGoal = tracker.totalGoal || 0;
  const savingsBalance = tracker.savingsBalance !== undefined ? tracker.savingsBalance : 0;
  const microTarget = tracker.microTarget || 0;
  const targetPeriodLabel = tracker.targetPeriodLabel || 'month';
  const transactions = tracker.transactions || [];

  const submitLog = (type) => {
    if (!logAmount) return;
    onLog(tracker.id, type, logAmount, logReason);
    setLogAmount('');
    setLogReason('');
  };

  const startEditing = (tx) => {
    setEditingTxId(tx.id);
    setEditAmount(tx.amount.toString());
    setEditReason(tx.reason);
  };

  const saveEdit = (txId) => {
    onEditTx(tracker.id, txId, editAmount, editReason);
    setEditingTxId(null);
  };

  const budgetRemainingPercent = totalGoal > 0 ? Math.max(0, ((savingsBalance / totalGoal) * 100)) : 0;
  const velocityGoalPercent = totalGoal > 0 ? Math.max(0, ((savingsBalance / totalGoal) * 100)) : 0;
  const currentMilestonePercent = microTarget > 0 ? Math.max(0, ((tracker.currentMilestoneSaved / microTarget) * 100)) : 0;

  return (
    <div className={`border p-5 rounded-2xl shadow-xl space-y-4 backdrop-blur-md transition-all duration-300 relative group ${
      theme === 'dark' ? 'bg-zinc-900/60 border-zinc-800/80 hover:border-zinc-700/60 shadow-black/40' : 'bg-white border-zinc-300 hover:border-zinc-400 shadow-zinc-200/40'
    }`}>
      
      <button 
        onClick={() => onDeleteTracker(tracker.id)}
        className="absolute top-4 right-4 text-zinc-400 hover:text-rose-500 transition-colors text-xs p-1 block sm:opacity-0 sm:group-hover:opacity-100"
        title="Remove entire budget tracker"
      >
        🗑️
      </button>

      <div className="flex justify-between items-start pr-6">
        <div>
          <span className={`text-xs uppercase font-mono tracking-widest px-2 py-0.5 rounded font-bold ${
            isExpenseMode 
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20' 
              : (theme === 'dark' ? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-100 text-zinc-700')
          }`}>
            {isExpenseMode ? 'expense control' : tracker.type === 'multi-year' ? `${tracker.yearsScale}-year schedule` : `${tracker.type} schedule`}
          </span>
          <h3 className={`text-base font-black mt-2 tracking-tight ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{tracker.name}</h3>
        </div>
        <div className="text-right">
          <div className={`text-xs font-bold uppercase tracking-wider ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {isExpenseMode ? 'starting budget' : 'total goal'}
          </div>
          <div className={`text-sm font-black font-mono ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{totalGoal.toLocaleString()} BDT</div>
        </div>
      </div>

      <div className={`grid grid-cols-2 gap-4 border-y py-3.5 ${theme === 'dark' ? 'border-zinc-900' : 'border-zinc-200'}`}>
        <div>
          <div className={`text-xs uppercase tracking-widest font-bold mb-0.5 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {isExpenseMode ? 'funds remaining' : 'total money saved'}
          </div>
          <div className={`text-lg font-black font-mono ${
            isExpenseMode && savingsBalance < totalGoal * 0.2 ? 'text-rose-500 animate-pulse' : (theme === 'dark' ? 'text-white' : 'text-zinc-950')
          }`}>
            {savingsBalance.toLocaleString()} <span className={`text-xs font-normal ${theme === 'dark' ? 'text-zinc-500' : 'text-zinc-500'}`}>BDT</span>
          </div>
        </div>
        <div className="text-right">
          <div className={`text-xs uppercase tracking-widest font-bold mb-0.5 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {isExpenseMode ? 'total spent' : `target amount / ${targetPeriodLabel}`}
          </div>
          <div className={`text-sm font-black font-mono ${isExpenseMode ? 'text-rose-500' : (theme === 'dark' ? 'text-zinc-300' : 'text-zinc-700')}`}>
            {isExpenseMode ? (totalGoal - savingsBalance).toLocaleString() : microTarget.toLocaleString()} BDT
          </div>
        </div>
      </div>

      <div className={`space-y-3.5 p-4 rounded-xl border ${theme === 'dark' ? 'bg-black/40 border-zinc-900/60' : 'bg-zinc-50/50 border-zinc-200'}`}>
        {isExpenseMode ? (
          <div>
            <div className="flex justify-between text-xs mb-1.5 font-semibold">
              <span className={theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}>Budget pool health</span>
              <span className={`font-mono ${savingsBalance < totalGoal * 0.2 ? 'text-rose-600' : 'text-emerald-600'}`}>{budgetRemainingPercent.toFixed(1)}% remaining</span>
            </div>
            <div className={`w-full h-2 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
              <div 
                className={`h-2 rounded-full transition-all duration-500 ease-out ${
                  savingsBalance < totalGoal * 0.2 ? 'bg-rose-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, budgetRemainingPercent)}%` }}
              ></div>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="flex justify-between text-xs mb-1.5 font-semibold">
                <span className={theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}>Current schedule progress</span>
                <span className={`font-mono ${theme === 'dark' ? 'text-white' : 'text-zinc-950'}`}>{currentMilestonePercent.toFixed(1)}%</span>
              </div>
              <div className={`w-full h-2 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
                <div 
                  className={`h-2 rounded-full transition-all duration-500 ease-out ${
                    tracker.currentMilestoneSaved >= microTarget ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : (theme === 'dark' ? 'bg-white' : 'bg-zinc-950')
                  }`}
                  style={{ width: `${Math.min(100, currentMilestonePercent)}%` }}
                ></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1.5 font-semibold">
                <span className={theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}>Overall tracking progress</span>
                <span className={`font-mono ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>{velocityGoalPercent.toFixed(1)}%</span>
              </div>
              <div className={`w-full h-1.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
                <div 
                  className={`h-1.5 rounded-full transition-all duration-500 ease-out ${theme === 'dark' ? 'bg-zinc-600' : 'bg-zinc-400'}`}
                  style={{ width: `${Math.min(100, velocityGoalPercent)}%` }}
                ></div>
              </div>
            </div>
          </>
        )}
      </div>

      {isExpenseMode ? (
        <div className={`text-xs py-2.5 px-3 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 border font-bold animate-fadeIn ${
          savingsBalance === 0 
            ? 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400'
            : savingsBalance < totalGoal * 0.2 
            ? 'bg-amber-500/5 border-amber-500/20 text-amber-600 dark:text-amber-400' 
            : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
        }`}>
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full shrink-0 ${savingsBalance < totalGoal * 0.2 ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`}></span>
            {savingsBalance === 0 
              ? 'Alert: Running budget empty. Try to slow down expenses.'
              : savingsBalance < totalGoal * 0.2
              ? `Warning: Running low. Only ${savingsBalance.toLocaleString()} BDT left.`
              : 'Status: Healthy budget balance.'
            }
          </div>
          <button
            onClick={() => onSettle(tracker.id)}
            className={`text-[10px] uppercase tracking-wider font-extrabold px-2.5 py-1 rounded transition-all active:scale-90 align-middle self-end sm:self-auto ${
              theme === 'dark' ? 'bg-zinc-800 hover:bg-zinc-700 text-white' : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-900'
            }`}
          >
            Next month 🔄
          </button>
        </div>
      ) : (
        tracker.currentMilestoneSaved >= microTarget && (
          <div className="text-xs py-2.5 px-3 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 border font-bold animate-fadeIn bg-emerald-500/5 border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Periodic milestone goal achieved!
            </div>
            <button
              onClick={() => onSettle(tracker.id)}
              className={`text-[10px] uppercase tracking-wider font-extrabold px-2.5 py-1 rounded transition-all active:scale-90 self-end sm:self-auto ${
                theme === 'dark' ? 'bg-emerald-950 hover:bg-emerald-900 text-emerald-400' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700'
              }`}
            >
              Complete period ✓
            </button>
          </div>
        )
      )}

      <div className={`space-y-2 p-2.5 rounded-xl border ${theme === 'dark' ? 'bg-black/20 border-zinc-900' : 'bg-zinc-50 border-zinc-200'}`}>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            placeholder="Amount (BDT)"
            value={logAmount}
            onChange={(e) => setLogAmount(e.target.value)}
            className={`border rounded-lg px-3 py-2.5 text-base focus:outline-none font-mono transition-colors ${
              theme === 'dark' ? 'bg-zinc-950 border-zinc-900 focus:bg-zinc-900 text-white placeholder:text-zinc-600' : 'bg-white border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
            }`}
          />
          <input
            type="text"
            placeholder="Note (e.g., Rent)"
            value={logReason}
            onChange={(e) => setLogReason(e.target.value)}
            className={`border rounded-lg px-3 py-2.5 text-base focus:outline-none transition-colors ${
              theme === 'dark' ? 'bg-zinc-950 border-zinc-900 focus:bg-zinc-900 text-white placeholder:text-zinc-600' : 'bg-white border-zinc-300 text-zinc-900 placeholder:text-zinc-400'
            }`}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => submitLog('deposit')}
            className={`font-bold py-2.5 rounded-lg text-xs transition-all tracking-wide active:scale-[0.97] shadow-sm ${
              theme === 'dark' ? 'bg-zinc-100 hover:bg-white text-black' : 'bg-zinc-950 hover:bg-zinc-900 text-white'
            }`}
          >
            {isExpenseMode ? 'Add extra funds' : 'Log savings deposit'}
          </button>
          <button
            type="button"
            onClick={() => submitLog('expense')}
            className="font-bold py-2.5 rounded-lg text-xs transition-all border bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 active:scale-[0.97]"
          >
            {isExpenseMode ? 'Log an expense' : 'Log a withdrawal'}
          </button>
        </div>
      </div>

      {transactions.length > 0 && (
        <div className="pt-2 space-y-1.5">
          <span className={`text-xs uppercase tracking-wider font-bold px-0.5 ${theme === 'dark' ? 'text-zinc-400' : 'text-zinc-600'}`}>History logs</span>
          <div className="max-h-40 overflow-y-auto space-y-1.5 pr-0.5 custom-scrollbar">
            {transactions.map((tx) => (
              <div key={tx.id || Math.random().toString()} className={`border p-2.5 rounded-lg transition-all ${
                theme === 'dark' ? 'bg-black/40 border-zinc-900/60' : 'bg-zinc-50/60 border-zinc-200'
              }`}>
                {editingTxId === tx.id ? (
                  <div className="space-y-2 animate-fadeIn">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input 
                        type="number" 
                        value={editAmount} 
                        onChange={(e) => setEditAmount(e.target.value)}
                        className={`border rounded px-2 py-1.5 text-base font-mono ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-zinc-300'}`}
                      />
                      <input 
                        type="text" 
                        value={editReason} 
                        onChange={(e) => setEditReason(e.target.value)}
                        className={`border rounded px-2 py-1.5 text-base ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-white border-zinc-300'}`}
                      />
                    </div>
                    <div className="flex justify-end gap-1.5 text-xs">
                      <button 
                        onClick={() => setEditingTxId(null)} 
                        className="px-2.5 py-1 rounded border border-zinc-500 text-zinc-500 dark:text-zinc-400"
                      >
                        Cancel
                      </button>
                      <button 
                        onClick={() => saveEdit(tx.id)} 
                        className="px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500 font-bold"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-center text-xs sm:text-sm font-mono group/row gap-1">
                    <div className="flex items-center gap-2 max-w-[60%] overflow-hidden">
                      <span className={`text-[9px] font-extrabold px-1 py-0.5 rounded shrink-0 ${
                        tx.type === 'deposit' 
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' 
                          : tx.type === 'settlement' 
                          ? 'bg-blue-950 text-blue-400 border border-blue-800' 
                          : 'bg-rose-950 text-rose-400 border border-rose-800'
                      }`}>
                        {tx.type === 'deposit' ? 'IN' : tx.type === 'settlement' ? 'RESET' : 'OUT'}
                      </span>
                      <span className={`truncate ${theme === 'dark' ? 'text-zinc-300' : 'text-zinc-800'}`} title={tx.reason}>
                        {tx.reason || ''}
                      </span>
                    </div>
                    
                    <div className="text-right shrink-0 flex items-center gap-1.5 sm:gap-2">
                      <span className={`font-bold ${
                        tx.type === 'deposit' ? 'text-emerald-600 dark:text-emerald-400' : tx.type === 'settlement' ? 'text-blue-500 dark:text-blue-400' : 'text-rose-600 dark:text-rose-400'
                      }`}>
                        {tx.type === 'deposit' ? '+' : tx.type === 'settlement' ? '✓' : '-'}{(tx.amount || 0).toLocaleString()}
                      </span>
                      <span className={`text-[10px] ${theme === 'dark' ? 'text-zinc-500' : 'text-zinc-600'}`}>{tx.date || ''}</span>
                      
                      {tx.type !== 'settlement' && (
                        <div className="flex items-center gap-1.5 ml-1 block sm:opacity-0 sm:group-hover/row:opacity-100 transition-opacity">
                          <button 
                            onClick={() => startEditing(tx)} 
                            className="text-zinc-400 hover:text-amber-500 transition-colors px-0.5 text-xs"
                            title="Edit entry"
                          >
                            ✏️
                          </button>
                          <button 
                            onClick={() => onDeleteTx(tracker.id, tx.id)} 
                            className="text-zinc-400 hover:text-rose-500 transition-colors px-0.5 text-xs"
                            title="Delete entry"
                          >
                            ❌
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;