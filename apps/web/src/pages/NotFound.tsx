import React from 'react';

import styles from './NotFound.module.css';

// Import the CSS module

const NotFound: React.FC = () => {
  return (
    <div className={styles.notFoundContainer}>
      <h1>Page Not Found 👀️</h1>
    </div>
  );
};

export default NotFound;
