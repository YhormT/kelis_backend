const userService = require("../services/userService");
const { createTransaction } = require("../services/transactionService");
const path = require("path");
const fs = require("fs");
const prisma = require("../config/db");

const getAllUsers = async (req, res) => {
  try {
    const users = await userService.getAllUsers();
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createUser = async (req, res) => {
  try {
    const { name, email, password, role, phone } = req.body;
    const newUser = await userService.createUser({
      name,
      email,
      password,
      role,
      isLoggedIn: false, // Default to true for new users
      phone,
    });
    res.status(201).json(newUser);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateUser = async (req, res, io, userSockets) => {
  const { id } = req.params;
  const updatedData = req.body;

  try {
    // 1. Fetch the user's current state before the update
    const originalUser = await prisma.user.findUnique({ where: { id: parseInt(id) } });

    if (!originalUser) {
      return res.status(404).json({
        success: false,
        message: "User not found!",
      });
    }

    // 2. Perform the update
    const updatedUser = await userService.updateUser(parseInt(id), updatedData);

    // 3. Check if the role was changed
    if (updatedData.role && updatedData.role !== originalUser.role) {
      console.log(`Role for user ${id} changed from ${originalUser.role} to ${updatedData.role}. Triggering logout.`);
      
      // 4. Emit a 'role-updated' event to the user's socket
      const socketId = userSockets.get(parseInt(id));
      if (socketId) {
        console.log(`Sending role update to user ${id} on socket ${socketId}`);
        io.to(socketId).emit('role-updated', { newRole: updatedData.role });
      }
    }

    return res.status(200).json({
      success: true,
      message: "User updated successfully!",
      data: updatedUser,
    });

  } catch (error) {
    console.error("Error updating user:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while updating the user!",
    });
  }
};



// Admin adds loan to user  -- Godfrey
const assignLoan = async (req, res) => {
  const { userId, amount } = req.body;
  try {
    // Convert amount to number
    const loanAmount = Number(amount);
    
    // Use the dedicated loan assignment service
    const user = await userService.assignLoan(userId, loanAmount);
    
    res.json({ 
      message: "Loan assigned successfully",
      user 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
// Dedicated refund endpoint for wallet refunds
const refundUser = async (req, res) => {
  const { userId, amount, refundReference } = req.body;
  try {
    const user = await userService.refundUser(userId, Number(amount), refundReference);
    res.json({ message: "Refund added successfully", user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateLoanStatus = async (req, res) => {
  const { userId, hasLoan } = req.body;

  console.log("Received userId:", userId, "Type:", typeof userId); // Debugging log

  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: "Invalid user ID: userId must be a number." });
  }

  try {
    const user = await userService.updateLoanStatus(parseInt(userId, 10), hasLoan);
    res.json({ message: "Loan status updated successfully", user });
  } catch (error) {
    console.error("Error updating loan status:", error);
    res.status(500).json({ error: error.message });
  }
};

const repayLoan = async (req, res) => {
  const { userId, amount } = req.body;
  try {
    // Convert amount to number and ensure it's positive
    const repaymentAmount = Math.abs(Number(amount));
    
    // Get current loan balance
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { loanBalance: true }
    });
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Calculate new loan balance
    const newLoanBalance = Math.max(user.loanBalance - repaymentAmount, 0);
    
    // Update loan balance
    const updatedUser = await userService.repayLoan(userId, repaymentAmount);
    
    res.json({ 
      message: "Loan repaid successfully",
      user: updatedUser
    });
  } catch (error) {
    console.error("Error repaying loan:", error);
    res.status(500).json({ error: error.message });
  }
};

// 🔍 Get Loan Balance -- Godfrey
const getLoanBalance = async (req, res) => {
  const { userId } = req.params;
  try {
      const user = await userService.getUserLoanBalance(userId);
      res.json(user);
  } catch (error) {
      res.status(500).json({ error: error.message });
  }
};




const deleteUser = async (req, res) => {
  try {
    await userService.deleteUser(req.params.id);
    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    if (error.code === "P2003") {
      return res
        .status(400)
        .json({
          error: "Cannot delete user with active orders or cart items.",
        });
    }
    res.status(500).json({ error: error.message });
  }
};

const selectPackage = async (req, res) => {
  try {
    const { packageId } = req.body;
    const userId = req.user.id;

    const dataPackage = await prisma.dataPackage.findUnique({
      where: { id: packageId },
    });

    if (!dataPackage) {
      return res.status(404).json({ message: "Package not found" });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { selectedPackageId: packageId },
    });

    res.status(200).json({ message: "Package selected", dataPackage });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const uploadExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    console.log("File uploaded:", req.file.path);

    const result = await userService.processExcelFile(
      req.file.path,
      req.file.filename,
      userId // Pass userId from req.body
    );

    res.json(result);
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ error: error.message });
  }
};


// 📥 Download the Latest Processed Excel File
const downloadLatestExcel = async (req, res) => {
  try {
    const { latestFile, purchases } = await userService.getLatestFileData();
    const filePath = await userService.generateExcelFile(purchases);

    res.download(filePath, "purchases.xlsx", (err) => {
      if (err) {
        console.error("Download Error:", err);
        res.status(500).json({ error: "Error downloading file" });
      }

      // 🛠 Cleanup: Delete file after sending
      setTimeout(() => {
        fs.unlinkSync(filePath);
      }, 5000);
    });
  } catch (error) {
    console.error("Download Error:", error);
    res.status(500).json({ error: error.message });
  }
};

const downloadExcel = async (req, res) => {
  try {
    const { filename } = req.params;
    const { userId } = req.body; // Get userId from request body

    console.log({filename, userId})

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // Fetch file details from the database using findFirst
    const file = await prisma.upload.findFirst({
      where: { filename, userId },
    });

    console.log({file})

    if (!file) {
      return res.status(404).json({ error: "File not found or unauthorized" });
    }

    const filePath = path.join(__dirname, "../uploads", filename);

    console.log("Attempting to download:", filePath);

    if (!fs.existsSync(filePath)) {
      console.error("File not found on server:", filePath);
      return res.status(404).json({ error: "File not found on server" });
    }

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    res.download(filePath, filename, (err) => {
      if (err) {
        console.error("Download Error:", err);
        res.status(500).json({ error: "Failed to download file" });
      } else {
        console.log("File successfully downloaded:", filename);
      }
    });
  } catch (error) {
    console.error("Download Error:", error);
    res.status(500).json({ error: "Failed to download file" });
  }
};



const updateUserPassword = async (req, res) => {
  const { userId } = req.params; // Assuming userId is passed in the URL params
  const { newPassword } = req.body;

  try {
    const updatedUser = await userService.updatePassword(parseInt(userId), newPassword);
    res.status(200).json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}



const updateAdminLoanBalance = async (req, res) => {
  try {
    const { userId, hasLoan, adminLoanBalance } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const updatedUser = await userService.updateUserLoanStatus(userId, hasLoan, adminLoanBalance);

    res.status(200).json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


const updateAdminLoanBalanceController = async (req, res) => {
  try {
    const { userId, newBalance } = req.body;

    if (!userId || newBalance === undefined) {
      return res.status(400).json({ error: "userId and newBalance are required" });
    }

    const updatedUser = await userService.updateAdminLoanBalance(userId, newBalance);

    res.status(200).json({
      message: "adminLoanBalance updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  repayLoan,
  getLoanBalance,
  uploadExcel,
  // downloadExcel,
  downloadLatestExcel,
  downloadExcel,
  updateUserPassword,
  updateLoanStatus,
  updateAdminLoanBalance,
  updateAdminLoanBalanceController,
  refundUser,
  assignLoan
};
